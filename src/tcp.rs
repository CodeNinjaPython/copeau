use std::net::{IpAddr, Ipv6Addr};

pub fn parse_host(text: &str) -> Result<(String, u16), String> {
    let text = text.trim();
    let text = text.split_once("://").map_or(text, |(_, address)| address);
    let text = text.split('/').next().unwrap_or("").trim();
    if text.is_empty() {
        return Err("Adresse réseau manquante".into());
    }
    let (host, port) = if let Some(rest) = text.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| format!("Adresse réseau invalide : {text}"))?;
        host.parse::<Ipv6Addr>()
            .map_err(|_| format!("Adresse IPv6 invalide : {host}"))?;
        let port = if tail.is_empty() {
            None
        } else {
            Some(
                tail.strip_prefix(':')
                    .ok_or_else(|| format!("Adresse réseau invalide : {text}"))?,
            )
        };
        (host, port)
    } else {
        let mut parts = text.split(':');
        let host = parts.next().unwrap_or("");
        let port = parts.next();
        if parts.next().is_some() {
            return Err(format!("Adresse réseau invalide : {text}"));
        }
        (host, port)
    };
    if host.is_empty()
        || host.chars().any(|c| c.is_whitespace() || c.is_control())
        || (host.contains('[') || host.contains(']'))
    {
        return Err(format!("Adresse réseau invalide : {text}"));
    }
    let port = match port {
        None => 23,
        Some(value) => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(|| format!("Port réseau invalide : {value}"))?,
    };
    if host.contains(':') && host.parse::<IpAddr>().is_err() {
        return Err(format!("Adresse réseau invalide : {text}"));
    }
    Ok((host.to_string(), port))
}

#[derive(Clone, Copy, Default)]
enum TelnetState {
    #[default]
    Data,
    Iac,
    Option,
    Subnegotiation,
    SubnegotiationIac,
}

#[derive(Default)]
pub struct TelnetDecoder {
    state: TelnetState,
}

impl TelnetDecoder {
    pub fn decode(&mut self, input: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(input.len());
        for &byte in input {
            self.state = match self.state {
                TelnetState::Data if byte == 0xff => TelnetState::Iac,
                TelnetState::Data => {
                    output.push(byte);
                    TelnetState::Data
                }
                TelnetState::Iac if byte == 0xff => {
                    output.push(byte);
                    TelnetState::Data
                }
                TelnetState::Iac if byte == 0xfa => TelnetState::Subnegotiation,
                TelnetState::Iac if (0xfb..=0xfe).contains(&byte) => TelnetState::Option,
                TelnetState::Iac | TelnetState::Option => TelnetState::Data,
                TelnetState::Subnegotiation if byte == 0xff => TelnetState::SubnegotiationIac,
                TelnetState::Subnegotiation => TelnetState::Subnegotiation,
                TelnetState::SubnegotiationIac if byte == 0xf0 => TelnetState::Data,
                TelnetState::SubnegotiationIac => TelnetState::Subnegotiation,
            };
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_network_addresses_and_rejects_bad_ports() {
        assert_eq!(
            parse_host("192.168.1.50").unwrap(),
            ("192.168.1.50".into(), 23)
        );
        assert_eq!(
            parse_host("telnet://example.test:2323/").unwrap(),
            ("example.test".into(), 2323)
        );
        assert_eq!(parse_host("[::1]:42").unwrap(), ("::1".into(), 42));
        for invalid in ["", "host:", "host:0", "host:65536", "a:b:c", "[bad]:23"] {
            assert!(parse_host(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn strips_telnet_negotiations_split_across_reads() {
        let mut decoder = TelnetDecoder::default();
        assert_eq!(decoder.decode(b"ab\xff"), b"ab");
        assert_eq!(decoder.decode(b"\xfb"), b"");
        assert_eq!(decoder.decode(b"\x01c\xff\xfa\x18"), b"c");
        assert_eq!(decoder.decode(b"\x01\xff"), b"");
        assert_eq!(decoder.decode(b"\xf0d\xff\xff"), b"d\xff");
    }
}
