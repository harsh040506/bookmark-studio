/**
 * Whether an IP address is somewhere a fetch on the user's behalf must never go.
 *
 * One implementation for the server, its headless renderer and the extension. There used
 * to be three copies, and all three recognised an IPv4-mapped IPv6 address only in its
 * dotted spelling (`::ffff:127.0.0.1`). The WHATWG URL parser never produces that
 * spelling: `new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]`, so
 * the check ran against the hex form and called loopback public. A redirect to that
 * address reached services bound to 127.0.0.1 on a dual-stack host.
 *
 * So IPv6 is parsed to its sixteen bytes rather than matched as text, and every range
 * that embeds an IPv4 address (mapped, translated, compatible, NAT64, 6to4, Teredo) is
 * judged by the IPv4 address inside it.
 *
 * Anything that does not parse is treated as private: refusing an odd address costs one
 * preview, while allowing one could expose the user's network.
 */

/** Strips IPv6 brackets and a trailing root dot (`localhost.` resolves like `localhost`). */
export function bareHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function privateIPv4Bytes([a, b, c]: number[]): boolean {
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // documentation
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Parses any textual IPv6 form, including an embedded dotted quad, to sixteen bytes. */
function parseIPv6(address: string): number[] | null {
  let value = address;
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(":")) return null;

  let tail: number[] = [];
  const lastColon = value.lastIndexOf(":");
  const last = value.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail = v4;
    value = `${value.slice(0, lastColon + 1)}0:0`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const toGroups = (text: string) => (text ? text.split(":") : []);
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const word = parseInt(group, 16);
    bytes.push(word >> 8, word & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function privateIPv6Bytes(bytes: number[]): boolean {
  const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const v4At = (offset: number) => bytes.slice(offset, offset + 4);

  if (zero(0, 16)) return true; // ::
  if (zero(0, 15) && bytes[15] === 1) return true; // ::1
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated)
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return privateIPv4Bytes(v4At(12));
  if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(10, 12)) return privateIPv4Bytes(v4At(12));
  // ::a.b.c.d, the deprecated IPv4-compatible form
  if (zero(0, 12)) return privateIPv4Bytes(v4At(12));
  // 64:ff9b::/96, well-known NAT64: judged by the IPv4 address it reaches
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) {
    return privateIPv4Bytes(v4At(12));
  }
  // 64:ff9b:1::/48, local-use NAT64
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0 && bytes[5] === 1) {
    return true;
  }
  // 2002::/16, 6to4: the IPv4 address is bytes 2–5
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return privateIPv4Bytes(v4At(2));
  // 2001:0::/32, Teredo: the client address is the last four bytes, inverted
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    return privateIPv4Bytes(v4At(12).map((byte) => byte ^ 0xff));
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
  if (bytes[0] === 0x01 && zero(1, 8)) return true; // 100::/64 discard
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (bytes[0] === 0xff) return true; // multicast
  return false;
}

/** Which family a literal address is, or `null` when it is a name. */
export function ipFamily(hostname: string): 4 | 6 | null {
  const host = bareHost(hostname);
  if (parseIPv4(host)) return 4;
  if (parseIPv6(host)) return 6;
  return null;
}

/** True for any address that is not on the public internet, or that cannot be parsed. */
export function isPrivateAddress(address: string): boolean {
  const host = bareHost(address);
  const v4 = parseIPv4(host);
  if (v4) return privateIPv4Bytes(v4);
  const v6 = parseIPv6(host);
  if (v6) return privateIPv6Bytes(v6);
  return true;
}

/** Hostnames that only ever mean this machine or its local network. */
export function isLocalHostname(hostname: string): boolean {
  return /^(localhost|.*\.local|.*\.internal|.*\.localhost|.*\.home\.arpa|.*\.lan)$/i.test(bareHost(hostname));
}
