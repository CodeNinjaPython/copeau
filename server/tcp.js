import net from 'node:net';
import { EventEmitter } from 'node:events';

// Connexion réseau (Wi-Fi / Ethernet) à une carte qui expose sa console en
// TCP, souvent en telnet sur le port 23 (Smoothieware, grblHAL, ESP3D…).
// Même interface qu'un port série : data / close / error, write(), close().

const IAC = 0xff, SB = 0xfa, SE = 0xf0, WILL = 0xfb, DONT = 0xfe;

export function parseHost(text, defaultPort = 23) {
  const s = String(text || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (!s) throw new Error('Adresse réseau manquante (ex. 192.168.1.50 ou 192.168.1.50:23)');
  const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/) || s.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) throw new Error(`Adresse réseau invalide : ${s}`);
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!(port > 0 && port < 65536)) throw new Error(`Port invalide : ${m[2]}`);
  return { host: m[1], port };
}

export class TcpTransport extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.telnet = 'data'; // état du décodage telnet, conservé d'un paquet à l'autre
    socket.on('data', (d) => this.emit('data', this.stripTelnet(d)));
    socket.on('close', () => this.emit('close'));
    socket.on('error', (e) => this.emit('error', e));
  }

  static open(text, { timeout = 5000 } = {}) {
    const { host, port } = parseHost(text);
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Pas de réponse de ${host}:${port}`));
      }, timeout);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 5000);
        resolve(new TcpTransport(socket));
      });
      socket.once('error', (e) => { clearTimeout(timer); reject(new Error(`${host}:${port} : ${e.message}`)); });
    });
  }

  // Retire les négociations telnet (IAC …) qui précèdent parfois la console.
  // Une séquence peut être coupée entre deux paquets : l'état est gardé.
  stripTelnet(buf) {
    const out = [];
    for (const b of buf) {
      switch (this.telnet) {
        case 'iac': // octet après IAC
          if (b === IAC) { out.push(IAC); this.telnet = 'data'; } // IAC IAC = 0xFF littéral
          else if (b === SB) this.telnet = 'sb';
          else if (b >= WILL && b <= DONT) this.telnet = 'option';
          else this.telnet = 'data'; // commande simple (NOP…)
          break;
        case 'option': this.telnet = 'data'; break; // IAC WILL/WONT/DO/DONT <option>
        case 'sb': if (b === IAC) this.telnet = 'sb-iac'; break; // sous-négociation
        case 'sb-iac': this.telnet = b === SE ? 'data' : 'sb'; break;
        default:
          if (b === IAC) this.telnet = 'iac';
          else out.push(b);
      }
    }
    return Buffer.from(out);
  }

  write(data) { return this.socket.write(data); }

  close() { this.socket.destroy(); }
}
