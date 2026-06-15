// Pure-function CIF merger for refmac LIBIN. Plain CommonJS so main.js
// can require it without bundling, and the test suite (lib/__tests__/)
// can exercise it under Node without Electron.
//
// See the in-line docstring on mergeRefmacLinkCifs for why this exists
// and what shape of input it expects.

/**
 * Combine multiple per-link refmac CIFs (each one is the output of the
 * baby-gru `toRefmacReadyLinkCif` transform) into a single LIBIN that
 * refmac5 can consume.
 *
 * Each input CIF has the format:
 *   data_link_list  (1 catalog row in a loop_)
 *   data_mod_list   (2 catalog rows in a loop_)
 *   data_link_<id>  (per-link block with _chem_link_bond / angle / etc.)
 *   data_mod_<X>    (per-mod blocks with _chem_mod_atom / bond loops)
 *
 * Naively concatenating them produces N `data_link_list` blocks; refmac
 * only honors the FIRST and silently drops the rest — so the second-
 * declared link never gets its chem_link template registered, and refmac
 * falls back to proximity-only auto-detection for it.
 *
 * Strategy: extract the catalog rows from every input, deduplicate,
 * emit ONE merged `data_link_list` and ONE merged `data_mod_list` at the
 * top, then append every per-link/per-mod block (those have unique
 * names so no clash).
 *
 * @param {string[]} cifTexts
 * @returns {string} merged CIF
 */
function mergeRefmacLinkCifs(cifTexts) {
  if (!Array.isArray(cifTexts) || cifTexts.length === 0) return "";
  if (cifTexts.length === 1) return cifTexts[0];

  const linkRows = [];
  const modRows = [];
  const otherBlocks = [];

  for (const text of cifTexts) {
    const lines = text.split("\n");
    let i = 0;
    let passthroughBuf = [];

    const flushPassthrough = () => {
      if (passthroughBuf.length) {
        otherBlocks.push(passthroughBuf.join("\n"));
        passthroughBuf = [];
      }
    };

    while (i < lines.length) {
      const L = lines[i];
      const t = L.trim();
      if (t === "data_link_list") {
        flushPassthrough();
        i++;
        while (i < lines.length && !/^\s*data_/.test(lines[i])) {
          const ll = lines[i].trim();
          if (ll && !ll.startsWith("_") && ll !== "loop_") {
            linkRows.push(ll);
          }
          i++;
        }
        continue;
      }
      if (t === "data_mod_list") {
        flushPassthrough();
        i++;
        while (i < lines.length && !/^\s*data_/.test(lines[i])) {
          const ll = lines[i].trim();
          if (ll && !ll.startsWith("_") && ll !== "loop_") {
            modRows.push(ll);
          }
          i++;
        }
        continue;
      }
      passthroughBuf.push(L);
      i++;
    }
    flushPassthrough();
  }

  // Dedupe identical rows (same link/mod declared twice in different CIFs).
  const uniqueLinks = [...new Set(linkRows)];
  const uniqueMods = [...new Set(modRows)];

  const linkListBlock =
    "data_link_list\n" +
    "loop_\n" +
    "_chem_link.id\n" +
    "_chem_link.comp_id_1\n" +
    "_chem_link.mod_id_1\n" +
    "_chem_link.group_comp_1\n" +
    "_chem_link.comp_id_2\n" +
    "_chem_link.mod_id_2\n" +
    "_chem_link.group_comp_2\n" +
    "_chem_link.name\n" +
    uniqueLinks.join("\n") + "\n";
  const modListBlock =
    "\ndata_mod_list\n" +
    "loop_\n" +
    "_chem_mod.id\n" +
    "_chem_mod.name\n" +
    "_chem_mod.comp_id\n" +
    "_chem_mod.group_id\n" +
    uniqueMods.join("\n") + "\n";

  return linkListBlock + modListBlock + "\n" + otherBlocks.join("\n");
}

module.exports = { mergeRefmacLinkCifs };
