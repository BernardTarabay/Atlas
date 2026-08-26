// Duplicate detection (spec §12/§13) in two phases.
//
// PHASE 'exact' (the default, enqueued by hashProcessor right after hashing):
// SHA-256 equality. Provable, so it is the only duplicate claim allowed to
// carry HIGH confidence, and the only one auto-resolution acts on.
//
// PHASE 'probable' (enqueued by extractTextProcessor once text exists):
// content similarity short of a byte match -- a re-saved, re-exported,
// watermarked or metadata-stripped copy (docs/01-domain-model.md §1.3).
// It runs as a second phase of the SAME job type rather than a new one
// because it answers the same question against the same tables; splitting
// the *timing* is what matters, since exact detection needs only the hash
// (available immediately after hashing) while similarity needs extracted
// text (available much later in the pipeline).
//
// Probable groups are created as OPEN, MEDIUM-confidence-at-best suggestions
// and are never auto-resolved -- docs/01 §1.3 is explicit that probable
// duplicates require a human to confirm, and autoResolveDuplicatesProcessor
// correspondingly only touches EXACT groups.
const fileRepository = require("../../repositories/fileRepository");
const fileContentRepository = require("../../repositories/fileContentRepository");
const duplicateGroupRepository = require("../../repositories/duplicateGroupRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const duplicateGroupService = require("../../services/duplicateGroupService");
const similarity = require("../../services/similarityService");
const { DuplicateGroupType, DetectionMethod, ConfidenceLevel } = require("../../models/enums");

async function detectExact(file) {
  // Removed files are excluded deliberately. findBySha256 has no status
  // filter, so a file the user had already removed still counted toward
  // "more than one copy exists" and was re-added as a member of a fresh
  // group -- the duplicate the user dealt with reappeared on the Duplicates
  // page, and the reclaimable-bytes total counted bytes twice.
  // findProcessedTwinByHash already takes this care; this path did not.
  const matches = (await fileRepository.findBySha256(file.sha256_hash, file.owner_user_id))
    .filter((m) => m.status !== "deleted");
  if (matches.length <= 1) {
    return { phase: "exact", duplicatesFound: false };
  }

  // The exact group for this hash, keyed on the hash itself.
  //
  // This used to scan the matches for any existing group and create one if it
  // found none, which had two defects.
  //
  // First, findGroupContainingFile returns groups of ANY type, so a file
  // already sitting in a PROBABLE group -- a similarity guess -- captured the
  // branch, and byte-identical files were filed as a "probable" match. Not a
  // cosmetic mislabel: a byte-identical pair carries confidence 1.0 and a
  // similarity guess carries whatever it scored, so mislabelling the type
  // used to drop a provable pair into the path built for guesses. Auto-resolve
  // now keys on the SCORE rather than the type, which makes the consequence
  // milder, but the group type is still what the UI and the audit trail say
  // happened -- so getting it right still matters.
  //
  // Second, find-then-create is a race. Two copies of one file hash in
  // parallel (the queue runs four wide), both find nothing, both create a
  // group, and the pair ends up listed twice with its bytes double-counted.
  //
  // Keying the group on the content hash fixes both at once: the type is
  // exact by construction, and the unique index added in migration 027 means
  // the database decides who creates it.
  const group = await duplicateGroupRepository.findOrCreateExactGroup({
    // The group belongs to whoever owns the bytes. Identical files in two
    // different archives are two unrelated documents that happen to match,
    // and one group spanning both would offer to "resolve" by keeping a copy
    // neither user can see.
    ownerUserId: file.owner_user_id,
    contentKey: file.sha256_hash,
    detectionMethod: DetectionMethod.HASH,
    confidenceLevel: ConfidenceLevel.HIGH,
    confidenceScore: 1.0,
  });

  for (const match of matches) {
    await duplicateGroupRepository.addMember(group.id, match.id, 1.0);
  }

  // RESOLVE IT NOW, not on a page later.
  //
  // Detection used to end here, leaving the group `open` for somebody to go
  // and confirm on the Duplicates page. That page is gone: a group the system
  // is confident about is not a decision worth interrupting anyone for, and
  // 468 open groups is not a queue anybody empties. Resolving picks a canonical
  // copy and deletes nothing, so the worst case of getting it wrong is that the
  // wrong copy is labelled canonical -- visible, and reversible by reopening.
  //
  // Deliberately after the audit row below, so "detected" is always recorded
  // even if resolving throws.
  await auditLogRepository.record({
    action: "duplicate.detected",
    entityType: "duplicate_group",
    entityId: group.id,
    newState: { memberFileIds: matches.map((m) => m.id), sha256Hash: file.sha256_hash },
    reason: "SHA-256 match across multiple files",
  });

  const resolved = await duplicateGroupService.autoResolveGroup(group.id, file.owner_user_id);

  return {
    phase: "exact",
    duplicateGroupId: group.id,
    memberCount: matches.length,
    autoResolved: Boolean(resolved),
  };
}

async function detectProbable(file) {
  const content = await fileContentRepository.findByFile(file.id);
  const text = content?.extracted_text || "";

  // A thin extraction (a scanned cover page, a mostly-image PDF) can score
  // high against another thin extraction on boilerplate alone. Refusing to
  // compare is the honest outcome -- a false "probable duplicate" costs a
  // human review cycle and erodes trust in every other suggestion.
  if (!similarity.hasEnoughTextToCompare(text)) {
    return { phase: "probable", skipped: true, reason: "not enough extracted text to compare" };
  }

  // Already grouped as an exact duplicate? Then the probable tier has
  // nothing to add -- a pair can only occupy ONE of these relationships
  // (docs/01 §1.3).
  const existing = await duplicateGroupRepository.findGroupContainingFile(file.id);
  if (existing.some((g) => g.group_type === DuplicateGroupType.EXACT)) {
    return { phase: "probable", skipped: true, reason: "already in an exact duplicate group" };
  }

  const candidates = await fileRepository.listSimilarityCandidates(file);
  const matches = [];
  for (const candidate of candidates) {
    const score = similarity.textSimilarity(text, candidate.extracted_text);
    const confidenceLevel = similarity.confidenceForScore(score);
    if (confidenceLevel) {
      matches.push({ candidate, score, confidenceLevel });
    }
  }

  if (matches.length === 0) {
    return { phase: "probable", candidatesCompared: candidates.length, duplicatesFound: false };
  }

  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];

  // Reuse an existing probable group if one of the matches is already in
  // one, so a third near-copy joins the same group rather than spawning a
  // parallel one.
  let group = null;
  for (const match of matches) {
    const groups = await duplicateGroupRepository.findGroupContainingFile(match.candidate.id);
    const probable = groups.find((g) => g.group_type === DuplicateGroupType.PROBABLE);
    if (probable) {
      group = probable;
      break;
    }
  }
  if (!group) {
    group = await duplicateGroupRepository.createGroup({
      ownerUserId: file.owner_user_id,
      groupType: DuplicateGroupType.PROBABLE,
      detectionMethod: DetectionMethod.CONTENT_SIMILARITY,
      // Capped at MEDIUM by similarityService.confidenceForScore: HIGH is
      // reserved for provable (hash) identity.
      confidenceLevel: best.confidenceLevel,
      confidenceScore: best.score,
    });
  }

  await duplicateGroupRepository.addMember(group.id, file.id, best.score);
  for (const match of matches) {
    await duplicateGroupRepository.addMember(group.id, match.candidate.id, match.score);
  }

  await auditLogRepository.record({
    action: "duplicate.probable_detected",
    entityType: "duplicate_group",
    entityId: group.id,
    newState: {
      fileId: file.id,
      matches: matches.map((m) => ({
        fileId: m.candidate.id,
        filename: m.candidate.filename_current,
        similarityScore: Number(m.score.toFixed(4)),
        confidenceLevel: m.confidenceLevel,
      })),
      candidatesCompared: candidates.length,
    },
    reason: "Content similarity above the probable-duplicate threshold",
  });

  // Same rule as the exact path: the score decides, not the group type.
  // autoResolveGroup applies AUTO_RESOLVE_MIN_CONFIDENCE itself, so a weak
  // similarity match simply stays open rather than being guessed at.
  const autoResolved = Boolean(
    await duplicateGroupService.autoResolveGroup(group.id, file.owner_user_id)
  );

  return {
    autoResolved,
    phase: "probable",
    duplicateGroupId: group.id,
    candidatesCompared: candidates.length,
    matchCount: matches.length,
    bestScore: Number(best.score.toFixed(4)),
  };
}

async function handle({ fileId, phase = "exact" }) {
  const file = await fileRepository.findById(fileId);
  if (!file) {
    return { skipped: true, reason: "file not found" };
  }

  if (phase === "probable") {
    if (file.status !== "active") {
      return { phase: "probable", skipped: true, reason: "file not active" };
    }
    return detectProbable(file);
  }

  if (!file.sha256_hash) {
    return { skipped: true, reason: "file not hashed yet" };
  }
  return detectExact(file);
}

module.exports = { handle };
