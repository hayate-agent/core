// SPDX-License-Identifier: Apache-2.0
/** Conservative binary policy, checked before compilation. The engine still
 * validates the complete module. No imports, memory64, shared or unbounded limits.
 */
export function validateWasmLimits(bytes: Uint8Array): void {
  if (bytes.length < 8 || ![0,97,115,109,1,0,0,0].every((v,i) => bytes[i] === v)) throw Error("Invalid Wasm header");
  let offset = 8, end = bytes.length;
  const byte = () => { if (offset >= end) throw Error("Invalid Wasm section"); return bytes[offset++]; };
  const uint = () => {
    let value = 0;
    for (let i=0;i<5;i++) {
      const b = byte();
      if (i === 4 && b > 15) throw Error("Invalid Wasm integer");
      value += (b & 127) * 2 ** (7*i);
      if (!(b & 128)) return value;
    }
    throw Error("Invalid Wasm integer");
  };
  const limits = (cap: number) => {
    if (byte() !== 1) throw Error("Wasm limits must have an explicit non-shared maximum");
    const min = uint(), max = uint();
    if (min > max || max > cap) throw Error("Wasm resource maximum exceeded");
  };
  while (offset < bytes.length) {
    end = bytes.length;
    const id = byte(), size = uint();
    end = offset + size;
    if (end > bytes.length) throw Error("Invalid Wasm section size");
    if (id === 2) {
      if (uint() !== 0) throw Error("Wasm host imports forbidden");
    } else if (id === 4 || id === 5) {
      const count = uint();
      if (count > 1) throw Error("Too many Wasm memories or tables");
      for (let i=0;i<count;i++) {
        if (id === 4 && byte() !== 0x70) throw Error("Only function tables supported");
        limits(id === 4 ? 4096 : 256); // 16 MiB linear memory, 4096 table entries
      }
    }
    if ([2,4,5].includes(id) && offset !== end) throw Error("Invalid Wasm resource section");
    offset = end;
  }
}
