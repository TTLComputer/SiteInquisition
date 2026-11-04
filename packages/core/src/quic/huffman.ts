/**
 * The HPACK Huffman code (RFC 7541 appendix B), shared by QPACK. The code is
 * canonical, so it is stored as one code length per symbol (A = 5 bits, B =
 * 6, ...) and the codes are rebuilt from the lengths.
 */
const LENGTHS =
  'ISXXXXXXXTZXXZXXXXXXXXZXXXXXXXXXBFFHIBDGFFDGDBBBAAABBBBBBBCDKBHFIBCCCCCCCCCCCCCCCCCCCCCCDCDIOIJBKABABABBBACCBBBABCBAABCCCCCKGJIXPRPPRRRSRSSSSSTSTTRSTSSSSQRSRSSTRQPRRSSQSRRTQRSSQQRQSRSSPRRRSRRSVVPORSRUVVVWWVTUOQVWWVWTQQVVXWWWPTPQRQQSRRUUTTVSVWVVWWWWWXWWWWWVZ';

const len: number[] = [...LENGTHS].map((c) => c.charCodeAt(0) - 65 + 5);
const code: number[] = new Array(257).fill(0);
{
  const order = [...len.keys()].sort((a, b) => len[a]! - len[b]! || a - b);
  let c = 0;
  let prev = len[order[0]!]!;
  order.forEach((s, i) => {
    if (i) c = (c + 1) * 2 ** (len[s]! - prev);
    prev = len[s]!;
    code[s] = c;
  });
}

/** Decoding tree: each node is [child0, child1]; leaves are symbol numbers stored as -(sym + 1). */
const tree: Array<[number, number]> = [[0, 0]];
for (let s = 0; s < 257; s++) {
  let node = 0;
  for (let b = len[s]! - 1; b >= 0; b--) {
    const bit = Math.floor(code[s]! / 2 ** b) % 2;
    if (b === 0) tree[node]![bit] = -(s + 1);
    else {
      let next = tree[node]![bit]!;
      if (!next) {
        next = tree.length;
        tree.push([0, 0]);
        tree[node]![bit] = next;
      }
      node = next;
    }
  }
}

export function huffmanLength(data: Uint8Array): number {
  let bits = 0;
  for (const b of data) bits += len[b]!;
  return Math.ceil(bits / 8);
}

export function huffmanEncode(data: Uint8Array): Buffer {
  const out = Buffer.alloc(huffmanLength(data));
  let acc = 0;
  let n = 0;
  let o = 0;
  for (const b of data) {
    let l = len[b]!;
    const c = code[b]!;
    // Codes are up to 30 bits; feed them in pieces so acc stays within 32 bits.
    while (l > 0) {
      const take = Math.min(l, 8);
      const piece = Math.floor(c / 2 ** (l - take)) % 2 ** take;
      acc = (acc << take) | piece;
      n += take;
      l -= take;
      while (n >= 8) {
        out[o++] = (acc >> (n - 8)) & 0xff;
        n -= 8;
      }
      acc &= (1 << n) - 1;
    }
  }
  if (n > 0) out[o++] = ((acc << (8 - n)) | ((1 << (8 - n)) - 1)) & 0xff;
  return out;
}

export function huffmanDecode(data: Uint8Array): Buffer {
  const out: number[] = [];
  let node = 0;
  let depth = 0;
  let allOnes = true;
  for (const byte of data) {
    for (let b = 7; b >= 0; b--) {
      const bit = (byte >> b) & 1;
      const next = tree[node]![bit]!;
      depth++;
      if (!bit) allOnes = false;
      if (next < 0) {
        const sym = -next - 1;
        if (sym === 256) throw new Error('Huffman string contains EOS');
        out.push(sym);
        node = 0;
        depth = 0;
        allOnes = true;
      } else if (next === 0) throw new Error('invalid Huffman code');
      else node = next;
    }
  }
  // Padding must be shorter than 8 bits and all ones (the EOS prefix).
  if (depth > 7 || !allOnes) throw new Error('invalid Huffman padding');
  return Buffer.from(out);
}
