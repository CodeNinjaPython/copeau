use crate::{
    controller::{Controller, Source},
    gcode::{fmt, Point},
};
use serde_json::{json, Value};

type Result<T> = std::result::Result<T, String>;

struct Options {
    fast_feed: f64,
    slow_feed: f64,
    backoff: f64,
    travel: f64,
    retract: f64,
    plate: f64,
    tool_dia: f64,
    wall: f64,
    inset: f64,
    depth: f64,
    max_radius: f64,
}

fn number(params: &Value, key: &str, default: f64) -> Result<f64> {
    let Some(value) = params.get(key) else {
        return Ok(default);
    };
    if value.is_null() || value.as_str() == Some("") {
        return Ok(default);
    }
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|v| v.parse::<f64>().ok()))
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("Paramètre de palpage invalide : {key}"))?;
    Ok(number)
}

impl Options {
    fn parse(params: &Value) -> Result<Self> {
        let result = Self {
            fast_feed: number(params, "fastFeed", 150.0)?,
            slow_feed: number(params, "slowFeed", 30.0)?,
            backoff: number(params, "backoff", 2.0)?,
            travel: number(params, "travel", 25.0)?,
            retract: number(params, "retract", 5.0)?,
            plate: number(params, "plate", 0.0)?,
            tool_dia: number(params, "toolDia", 6.0)?,
            wall: number(params, "wall", 0.0)?,
            inset: number(params, "inset", 10.0)?,
            depth: number(params, "depth", 3.0)?,
            max_radius: number(params, "maxRadius", 30.0)?,
        };
        if result.fast_feed <= 0.0
            || result.slow_feed <= 0.0
            || result.backoff <= 0.0
            || result.travel <= 0.0
            || result.tool_dia <= 0.0
            || result.max_radius <= 0.0
            || result.retract < 0.0
            || result.inset < 0.0
            || result.depth < 0.0
        {
            return Err("Vitesses et distances de palpage invalides".into());
        }
        Ok(result)
    }
}

async fn cmd(controller: &Controller, line: String) -> Result<()> {
    controller.command(line, Source::Probe).await
}

async fn sync(controller: &Controller) -> Result<Point> {
    controller.command("G4P0.01".into(), Source::Sync).await?;
    Ok(controller.next_status().await?.mpos)
}

async fn probe_once(
    controller: &Controller,
    axis: char,
    direction: f64,
    travel: f64,
    feed: f64,
) -> Result<Point> {
    controller.clear_probe().await?;
    cmd(
        controller,
        format!("G91G38.2{axis}{}F{}", fmt(direction * travel), fmt(feed)),
    )
    .await?;
    let state = controller.view().await?;
    let reading = state
        .last_probe
        .filter(|p| p.ok && state.status.state != "Alarm")
        .ok_or_else(|| {
            format!(
                "Pas de contact sur {axis}{} dans {} mm",
                if direction > 0.0 { '+' } else { '-' },
                fmt(travel)
            )
        })?;
    Ok(reading.position)
}

async fn probe_axis(
    controller: &Controller,
    axis: char,
    direction: f64,
    travel: f64,
    options: &Options,
) -> Result<Point> {
    probe_once(controller, axis, direction, travel, options.fast_feed).await?;
    cmd(
        controller,
        format!("G91G0{axis}{}", fmt(-direction * options.backoff)),
    )
    .await?;
    let contact = probe_once(
        controller,
        axis,
        direction,
        options.backoff + 1.0,
        options.slow_feed,
    )
    .await?;
    cmd(
        controller,
        format!("G91G0{axis}{}", fmt(-direction * options.backoff)),
    )
    .await?;
    Ok(contact)
}

fn wcs_p(wcs: &str) -> Result<u8> {
    let number = wcs
        .strip_prefix('G')
        .and_then(|v| v.parse::<u8>().ok())
        .filter(|v| (54..=59).contains(v))
        .ok_or_else(|| "Repère de travail inconnu".to_string())?;
    Ok(number - 53)
}

async fn z(controller: &Controller, options: &Options) -> Result<Value> {
    cmd(controller, "G21".into()).await?;
    let point = probe_axis(controller, 'Z', -1.0, options.travel, options).await?;
    let p = wcs_p(&controller.view().await?.modal.wcs)?;
    cmd(
        controller,
        format!("G10L2P{p}Z{}", fmt(point.z - options.plate)),
    )
    .await?;
    cmd(controller, format!("G91G0Z{}", fmt(options.retract))).await?;
    Ok(json!({
        "message":format!("Z0 fixé (contact machine Z {}, cale {} mm)", fmt(point.z), fmt(options.plate)),
        "Z":point.z
    }))
}

async fn corner(controller: &Controller, options: &Options, corner: &str) -> Result<Value> {
    if !["FL", "FR", "BL", "BR"].contains(&corner) {
        return Err("Coin de palpage invalide".into());
    }
    let dx = if corner.contains('L') { 1.0 } else { -1.0 };
    let dy = if corner.contains('F') { 1.0 } else { -1.0 };
    let radius = options.tool_dia / 2.0;
    cmd(controller, "G21".into()).await?;
    let start = sync(controller).await?;
    let pz = probe_axis(controller, 'Z', -1.0, options.travel, options).await?;
    let top = pz.z - options.plate;
    let safe = pz.z + options.retract;
    let low = top - options.depth;
    let out = options.inset + radius + 5.0;

    cmd(controller, format!("G90G53G0Z{}", fmt(safe))).await?;
    cmd(
        controller,
        format!("G90G53G0X{}Y{}", fmt(start.x - dx * out), fmt(start.y)),
    )
    .await?;
    cmd(controller, format!("G90G53G0Z{}", fmt(low))).await?;
    let px = probe_axis(controller, 'X', dx, out + 5.0, options).await?;
    let edge_x = px.x + dx * (radius + options.wall);

    cmd(controller, format!("G90G53G0Z{}", fmt(safe))).await?;
    cmd(
        controller,
        format!("G90G53G0X{}Y{}", fmt(start.x), fmt(start.y - dy * out)),
    )
    .await?;
    cmd(controller, format!("G90G53G0Z{}", fmt(low))).await?;
    let py = probe_axis(controller, 'Y', dy, out + 5.0, options).await?;
    let edge_y = py.y + dy * (radius + options.wall);

    cmd(controller, format!("G90G53G0Z{}", fmt(safe))).await?;
    let p = wcs_p(&controller.view().await?.modal.wcs)?;
    cmd(
        controller,
        format!("G10L2P{p}X{}Y{}Z{}", fmt(edge_x), fmt(edge_y), fmt(top)),
    )
    .await?;
    cmd(controller, "G90G0X0Y0".into()).await?;
    Ok(
        json!({"message":format!("Origine posée sur le coin {corner}"),"edgeX":edge_x,"edgeY":edge_y,"top":top}),
    )
}

async fn measure(
    controller: &Controller,
    options: &Options,
    center: &mut Point,
    axis: char,
) -> Result<f64> {
    let a = probe_axis(controller, axis, 1.0, options.max_radius, options).await?;
    cmd(
        controller,
        format!("G90G53G0{axis}{}", fmt(center.get(axis))),
    )
    .await?;
    let b = probe_axis(controller, axis, -1.0, options.max_radius, options).await?;
    center.set(axis, (a.get(axis) + b.get(axis)) / 2.0);
    cmd(
        controller,
        format!("G90G53G0{axis}{}", fmt(center.get(axis))),
    )
    .await?;
    Ok(a.get(axis) - b.get(axis) + options.tool_dia)
}

async fn center(controller: &Controller, options: &Options) -> Result<Value> {
    cmd(controller, "G21".into()).await?;
    let mut center = sync(controller).await?;
    measure(controller, options, &mut center, 'X').await?;
    let diameter_y = measure(controller, options, &mut center, 'Y').await?;
    let diameter_x = measure(controller, options, &mut center, 'X').await?;
    let p = wcs_p(&controller.view().await?.modal.wcs)?;
    cmd(
        controller,
        format!("G10L2P{p}X{}Y{}", fmt(center.x), fmt(center.y)),
    )
    .await?;
    Ok(json!({
        "message":format!("Centre trouvé, Ø X {} mm / Ø Y {} mm", fmt(diameter_x), fmt(diameter_y)),
        "center":center,"diameterX":diameter_x,"diameterY":diameter_y
    }))
}

pub async fn run(controller: &Controller, kind: &str, params: &Value) -> Result<Value> {
    let options = Options::parse(params)?;
    let view = controller.view().await?;
    if !view.ready {
        return Err("Machine non connectée".into());
    }
    if view.restoring_modes {
        return Err("Rétablissement des modes après palpage : palpage refusé".into());
    }
    if view.status.state != "Idle" {
        return Err(format!(
            "La machine doit être Idle (état : {})",
            view.status.state
        ));
    }
    if view
        .job_state
        .as_deref()
        .is_some_and(|s| ["running", "paused", "spinup", "finishing", "stopping"].contains(&s))
    {
        return Err("Un job est en cours".into());
    }
    cmd(controller, "$G".into()).await?;
    let modal = controller.view().await?.modal;
    let result = match kind {
        "z" => z(controller, &options).await,
        "corner" => {
            let corner_name = params
                .get("corner")
                .and_then(Value::as_str)
                .unwrap_or("FL")
                .to_uppercase();
            corner(controller, &options, &corner_name).await
        }
        "center" => center(controller, &options).await,
        _ => return Err(format!("Palpage inconnu : {kind}")),
    };
    let state = controller.view().await?;
    let restore = if !state.ready {
        Err("Machine déconnectée : modes non rétablis après palpage".into())
    } else if state.status.state == "Alarm" {
        controller
            .defer_mode_restore(modal.units.clone(), modal.distance.clone())
            .await
    } else {
        async {
            cmd(controller, modal.units.clone()).await?;
            cmd(controller, modal.distance.clone()).await?;
            cmd(controller, "$G".into()).await
        }
        .await
    };
    if let Err(error) = restore {
        controller
            .log("err", format!("Restauration après palpage : {error}"))
            .await?;
        if state.ready && state.status.state != "Alarm" && controller.view().await?.ready {
            if let Err(retry_error) = controller
                .defer_mode_restore(modal.units, modal.distance)
                .await
            {
                controller
                    .log(
                        "err",
                        format!("Rétablissement différé impossible : {retry_error}"),
                    )
                    .await?;
            }
        }
        if result.is_ok() {
            return Err(error);
        }
    }
    result
}
