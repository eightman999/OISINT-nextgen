// Portable public-unicast classifier used by the Cloudflare egress boundary.
// Keep the same negative fixtures as the Supabase Edge classifier; both layers
// must reject independently.

function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN);
  return octets.every((part) => Number.isInteger(part) && part <= 255) ? octets : null;
}

function parseIpv6(value: string): readonly number[] | null {
  let input = value.toLowerCase();
  if (input.startsWith("[") && input.endsWith("]")) input = input.slice(1, -1);
  if (!input || input.includes("%")) return null;

  const dottedTail = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedTail) {
    const ipv4 = parseIpv4(dottedTail[1]);
    if (!ipv4) return null;
    input = input.slice(0, -dottedTail[1].length) +
      `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:` +
      `${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  if ((input.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = input.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const compressed = input.includes("::");
  const missing = 8 - left.length - right.length;
  if ((compressed && missing < 1) || (!compressed && missing !== 0)) return null;

  const groups = [...left, ...Array(compressed ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

function isPublicIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function embeddedIpv4(groups: readonly number[]): readonly number[] {
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

function isPublicIpv6(groups: readonly number[]): boolean {
  const firstSixZero = groups.slice(0, 6).every((group) => group === 0);
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const nat64WellKnown = groups[0] === 0x64 && groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0);
  if (firstSixZero || ipv4Mapped || nat64WellKnown) {
    return isPublicIpv4(embeddedIpv4(groups));
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return false;
  if (groups[0] === 0x2002) {
    return isPublicIpv4([
      groups[1] >> 8,
      groups[1] & 0xff,
      groups[2] >> 8,
      groups[2] & 0xff,
    ]);
  }
  return !(
    (groups[0] & 0xfe00) === 0xfc00 ||
    (groups[0] & 0xffc0) === 0xfe80 ||
    (groups[0] & 0xffc0) === 0xfec0 ||
    (groups[0] & 0xff00) === 0xff00 ||
    (groups[0] === 0x100 && groups.slice(1, 4).every((group) => group === 0)) ||
    (groups[0] === 0x2001 && (groups[1] & 0xfe00) === 0) ||
    (groups[0] === 0x2001 && groups[1] === 0x0db8) ||
    (groups[0] & 0xe000) !== 0x2000
  );
}

export function isPublicIpAddress(value: string): boolean {
  const ipv4 = parseIpv4(value);
  if (ipv4) return isPublicIpv4(ipv4);
  const ipv6 = parseIpv6(value);
  return ipv6 ? isPublicIpv6(ipv6) : false;
}
