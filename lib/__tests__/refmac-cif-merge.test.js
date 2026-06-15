// Standalone Node test for the refmac LIBIN merger. No Jest / Electron
// dependency — runs as `node lib/__tests__/refmac-cif-merge.test.js`
// and exits non-zero on failure.
//
// Why a plain Node test instead of Jest: this code is wired into Electron's
// main process (main.js requires it), where the baby-gru Jest harness can't
// reach. Plain Node keeps it simple and the assertions are obvious.

const assert = require("node:assert");
const { mergeRefmacLinkCifs } = require("../refmac-cif-merge");

const CIF_ACR = `data_link_list
loop_
_chem_link.id
_chem_link.comp_id_1
_chem_link.mod_id_1
_chem_link.group_comp_1
_chem_link.comp_id_2
_chem_link.mod_id_2
_chem_link.group_comp_2
_chem_link.name
CYS-ACR CYS CYS-ACR-mod1 L-peptide 1E8 CYS-ACR-mod2 non-polymer "ACR linkage"

data_mod_list
loop_
_chem_mod.id
_chem_mod.name
_chem_mod.comp_id
_chem_mod.group_id
CYS-ACR-mod1 "ACR side1" CYS L-peptide
CYS-ACR-mod2 "ACR side2" 1E8 non-polymer

data_link_CYS-ACR
loop_
_chem_link_bond.link_id
_chem_link_bond.atom_1_comp_id
_chem_link_bond.atom_id_1
_chem_link_bond.atom_2_comp_id
_chem_link_bond.atom_id_2
_chem_link_bond.type
CYS-ACR 1 SG 2 CAA single

data_mod_CYS-ACR-mod1
loop_
_chem_mod_atom.mod_id
_chem_mod_atom.function
CYS-ACR-mod1 delete

data_mod_CYS-ACR-mod2
loop_
_chem_mod_atom.mod_id
_chem_mod_atom.function
CYS-ACR-mod2 add
`;

const CIF_YNA = `data_link_list
loop_
_chem_link.id
_chem_link.comp_id_1
_chem_link.mod_id_1
_chem_link.group_comp_1
_chem_link.comp_id_2
_chem_link.mod_id_2
_chem_link.group_comp_2
_chem_link.name
CYS-YNA CYS CYS-YNA-mod1 L-peptide XQQ CYS-YNA-mod2 non-polymer "YNA linkage"

data_mod_list
loop_
_chem_mod.id
_chem_mod.name
_chem_mod.comp_id
_chem_mod.group_id
CYS-YNA-mod1 "YNA side1" CYS L-peptide
CYS-YNA-mod2 "YNA side2" XQQ non-polymer

data_link_CYS-YNA
loop_
_chem_link_bond.link_id
_chem_link_bond.atom_1_comp_id
_chem_link_bond.atom_id_1
_chem_link_bond.atom_2_comp_id
_chem_link_bond.atom_id_2
_chem_link_bond.type
CYS-YNA 1 SG 2 CB double

data_mod_CYS-YNA-mod1
loop_
_chem_mod_atom.mod_id
_chem_mod_atom.function
CYS-YNA-mod1 delete

data_mod_CYS-YNA-mod2
loop_
_chem_mod_atom.mod_id
_chem_mod_atom.function
CYS-YNA-mod2 add
`;

function test(name, fn) {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (e) {
    console.log("  ✗ " + name);
    console.log("    " + e.message);
    process.exitCode = 1;
  }
}

console.log("mergeRefmacLinkCifs");

test("empty input returns empty string", () => {
  assert.strictEqual(mergeRefmacLinkCifs([]), "");
});

test("single input returns input unchanged (no-op)", () => {
  assert.strictEqual(mergeRefmacLinkCifs([CIF_ACR]), CIF_ACR);
});

test("two distinct inputs produce ONE data_link_list block", () => {
  const merged = mergeRefmacLinkCifs([CIF_ACR, CIF_YNA]);
  const matches = merged.match(/^data_link_list$/gm) || [];
  assert.strictEqual(matches.length, 1);
});

test("two distinct inputs produce ONE data_mod_list block", () => {
  const merged = mergeRefmacLinkCifs([CIF_ACR, CIF_YNA]);
  const matches = merged.match(/^data_mod_list$/gm) || [];
  assert.strictEqual(matches.length, 1);
});

test("merged data_link_list carries BOTH link catalog rows", () => {
  const merged = mergeRefmacLinkCifs([CIF_ACR, CIF_YNA]);
  assert.match(merged, /CYS-ACR CYS CYS-ACR-mod1 L-peptide 1E8/);
  assert.match(merged, /CYS-YNA CYS CYS-YNA-mod1 L-peptide XQQ/);
});

test("merged data_mod_list carries ALL FOUR mod catalog rows", () => {
  const merged = mergeRefmacLinkCifs([CIF_ACR, CIF_YNA]);
  assert.match(merged, /CYS-ACR-mod1 "ACR side1"/);
  assert.match(merged, /CYS-ACR-mod2 "ACR side2"/);
  assert.match(merged, /CYS-YNA-mod1 "YNA side1"/);
  assert.match(merged, /CYS-YNA-mod2 "YNA side2"/);
});

test("per-link blocks preserved verbatim", () => {
  const merged = mergeRefmacLinkCifs([CIF_ACR, CIF_YNA]);
  assert.match(merged, /data_link_CYS-ACR\s*\nloop_/);
  assert.match(merged, /data_link_CYS-YNA\s*\nloop_/);
  // The bond rows for each link must survive intact
  assert.match(merged, /CYS-ACR 1 SG 2 CAA single/);
  assert.match(merged, /CYS-YNA 1 SG 2 CB double/);
});

test("per-mod blocks preserved verbatim", () => {
  const merged = mergeRefmacLinkCifs([CIF_ACR, CIF_YNA]);
  assert.match(merged, /data_mod_CYS-ACR-mod1/);
  assert.match(merged, /data_mod_CYS-ACR-mod2/);
  assert.match(merged, /data_mod_CYS-YNA-mod1/);
  assert.match(merged, /data_mod_CYS-YNA-mod2/);
});

test("duplicate inputs are deduped in the catalog (but per-blocks may repeat)", () => {
  // If the user re-declares the same link, we end up with two identical
  // input CIFs. The catalog row should appear only once (refmac would
  // reject duplicate _chem_link.id rows otherwise). The per-link block
  // appears twice but refmac handles that — repeated data_link_<id>
  // blocks are tolerated.
  const merged = mergeRefmacLinkCifs([CIF_ACR, CIF_ACR]);
  const linkRows = merged.match(/^CYS-ACR CYS CYS-ACR-mod1/gm) || [];
  assert.strictEqual(linkRows.length, 1, "catalog row should be deduped");
});

test("output preserves alphabetical column order in the catalogs", () => {
  const merged = mergeRefmacLinkCifs([CIF_ACR, CIF_YNA]);
  // Sanity: the link catalog headers must appear in the documented order
  // because refmac is positional. _chem_link.id first, _chem_link.name last.
  const headerSection = merged.match(/data_link_list\s*\nloop_\s*\n([\s\S]*?)\nCYS-/m)[1];
  const headers = headerSection.split("\n").map(s => s.trim()).filter(Boolean);
  assert.deepStrictEqual(headers, [
    "_chem_link.id",
    "_chem_link.comp_id_1",
    "_chem_link.mod_id_1",
    "_chem_link.group_comp_1",
    "_chem_link.comp_id_2",
    "_chem_link.mod_id_2",
    "_chem_link.group_comp_2",
    "_chem_link.name",
  ]);
});

if (process.exitCode) {
  console.log("\n❌ some tests failed");
} else {
  console.log("\n✅ all tests passed");
}
