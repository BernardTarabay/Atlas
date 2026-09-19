// The legacy Office formats store "8-bit" text as CP1252, not Latin-1.
// Node's Buffer has no CP1252 decoder and its "latin1" is ISO-8859-1, which
// agrees with CP1252 everywhere EXCEPT 0x80-0x9F -- the range holding the
// curly quotes, em dash and ellipsis that real Word documents are full of.
// Decoding those as Latin-1 yields C1 control characters, which then get
// stripped as junk, silently eating punctuation from extracted text.
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, // 80-87
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, // 88-8F
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, // 90-97
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178, // 98-9F
];

function decodeCp1252(buffer) {
  let out = "";
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    out += String.fromCharCode(byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte);
  }
  return out;
}

module.exports = { decodeCp1252 };
