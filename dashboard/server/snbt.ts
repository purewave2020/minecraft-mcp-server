export type Nbt = null | boolean | number | string | Nbt[] | { [key: string]: Nbt };

/** Parse the server's textual NBT, including typed arrays and nested item components. */
export function parseSnbt(input: string): Nbt {
  if (input.length > 2_000_000) throw new Error('NBT response exceeds limit');
  let at = 0;
  function space(): void { while (/\s/.test(input[at] ?? '') && at < input.length) at++; }
  function quoted(): string {
    const quote = input[at++];
    let result = '';
    while (at < input.length) {
      const char = input[at++];
      if (char === quote) return result;
      if (char !== '\\') { result += char; continue; }
      const escaped = input[at++];
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (escaped === 'u' && /^[\da-f]{4}$/i.test(input.slice(at, at + 4))) {
        result += String.fromCharCode(parseInt(input.slice(at, at + 4), 16)); at += 4;
      } else result += escapes[escaped] ?? escaped;
    }
    throw new Error('Unterminated NBT string');
  }
  function value(depth = 0): Nbt {
    if (depth > 96) throw new Error('NBT is too deeply nested');
    space();
    const char = input[at];
    if (char === '"' || char === "'") return quoted();
    if (char === '{') {
      at++;
      const result: Record<string, Nbt> = Object.create(null) as Record<string, Nbt>;
      space();
      while (input[at] !== '}') {
        if (at >= input.length) throw new Error('Unterminated NBT compound');
        const start = at;
        let key: string;
        if (input[at] === '"' || input[at] === "'") key = quoted();
        else { while (at < input.length && !/[\s:]/.test(input[at])) at++; key = input.slice(start, at); }
        space();
        if (!key || input[at++] !== ':') throw new Error('Invalid NBT key');
        result[key] = value(depth + 1);
        space();
        if (input[at] === '}') break;
        if (input[at++] !== ',') throw new Error('Expected NBT comma');
        space();
      }
      at++; return result;
    }
    if (char === '[') {
      at++; space();
      if (/^[BIL];/i.test(input.slice(at, at + 2))) at += 2;
      const result: Nbt[] = [];
      space();
      while (input[at] !== ']') {
        if (at >= input.length) throw new Error('Unterminated NBT list');
        result.push(value(depth + 1)); space();
        if (input[at] === ']') break;
        if (input[at++] !== ',') throw new Error('Expected NBT list comma');
        space();
      }
      at++; return result;
    }
    const start = at;
    while (at < input.length && !/[\s,\]}]/.test(input[at])) at++;
    const token = input.slice(start, at);
    if (!token) throw new Error('Expected NBT value');
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[bslfd]?$/i.test(token)) {
      const number = Number(token.replace(/[bslfd]$/i, ''));
      if (Number.isFinite(number)) return number;
    }
    return token;
  }
  const result = value(); space();
  if (at !== input.length) throw new Error('Unexpected trailing NBT');
  return result;
}
