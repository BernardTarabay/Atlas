const documentTypeRepository = require("../repositories/documentTypeRepository");

/**
 * The taxonomy's second axis, as a plain list.
 *
 * This is what the type filter on the Files page and the type dropdown in the
 * file editor bind to, and they want an array, not an envelope.
 *
 * There was a `browse` action here too, returning the same types with a
 * filtered file count against each plus an untyped total. It existed for one
 * caller, the Types page, and went with it: two aggregate scans over
 * classification_results are not something to keep running for a screen
 * nothing links to.
 */
async function list(req, res) {
  res.json(await documentTypeRepository.list({ limit: 200 }));
}

module.exports = { list };
