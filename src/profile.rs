use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Profile {
    #[default]
    Cnc,
    LaserGrbl,
    Emblaser2,
}

impl Profile {
    pub fn parse(id: &str) -> Result<Self, String> {
        match id {
            "cnc" => Ok(Self::Cnc),
            "laser-grbl" => Ok(Self::LaserGrbl),
            "emblaser2" => Ok(Self::Emblaser2),
            _ => Err(format!("Profil de machine inconnu : {id}")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Cnc => "cnc",
            Self::LaserGrbl => "laser-grbl",
            Self::Emblaser2 => "emblaser2",
        }
    }

    pub fn laser(self) -> bool {
        self != Self::Cnc
    }

    pub fn smoothie(self) -> bool {
        self == Self::Emblaser2
    }

    pub fn firmware(self) -> &'static str {
        if self.smoothie() {
            "smoothie"
        } else {
            "grbl"
        }
    }

    pub fn all() -> Value {
        json!([
            {"id":"cnc","label":"CNC Grbl (fraiseuse)","firmware":"grbl","laser":false},
            {"id":"laser-grbl","label":"Laser Grbl ($32=1)","firmware":"grbl","laser":true,"sMax":null,"defaultSMax":1000},
            {"id":"emblaser2","label":"Emblaser 2 (Smoothieware)","firmware":"smoothie","laser":true,"sMax":1,"defaultSMax":1,"area":{"X":500,"Y":300,"Z":50}}
        ])
    }
}
