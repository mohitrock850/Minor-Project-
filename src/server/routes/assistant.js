'use strict';

/**
 * AI Assistant endpoints (Section 14).
 *
 * The only routes in the application that can cause an outbound network request,
 * and even then only to api.openai.com with the administrator's own key. Every
 * other feature works with the network unplugged, so these endpoints are written
 * to fail politely and explain themselves rather than break anything:
 *
 *   GET  /status      is it configured, is OS encryption available, which model
 *   GET  /suggestions the canned questions for the panel
 *   POST /preview     exactly what would be transmitted, before anything is sent
 *   POST /ask         ask a question about this college's timetable
 *   POST /test        Test Connection (Settings)
 *
 * The key itself is never returned by any of these -- only the last four
 * characters, as a hint.
 */

const express = require('express');
const ai = require('../services/ai');
const secrets = require('../services/secrets');
const settings = require('../services/settings');
const { httpError, requireCollege, requireCoordinator } = require('../auth/middleware');

const router = express.Router();

// ---------------------------------------------------------------------------
// Status and suggestions -- readable by any signed-in user
// ---------------------------------------------------------------------------
router.get('/status', (req, res, next) => {
  try {
    res.json({
      ...ai.status(),
      // Read-only accounts see the panel but cannot change any of this.
      canConfigure: !!(req.scope && req.scope.canWrite),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/suggestions', (req, res, next) => {
  try {
    res.json({ questions: ai.suggestedQuestions() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// What would be sent (Section 14.3 -- "show me before you send it")
// ---------------------------------------------------------------------------
router.post('/preview', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const body = req.body || {};
    res.json(ai.previewContext(collegeId, {
      timetableId: body.timetableId != null && body.timetableId !== '' ? Number(body.timetableId) : null,
      view: body.view || null,
    }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

/**
 * Faculty and students may ask questions, but only ever about their own week:
 * the view the question is answered against is taken from the token, not from
 * whatever the client asked for.
 */
function scopedView(req, requested) {
  const { scope } = req;
  if (scope.canWrite) return requested || null;
  if (scope.facultyId != null) return { type: 'faculty', id: scope.facultyId };
  if (scope.subSectionId != null) return { type: 'sub_section', id: scope.subSectionId };
  if (scope.sectionId != null) return { type: 'section', id: scope.sectionId };
  throw httpError(403,
    'Your login is not linked to a timetable yet, so there is nothing for the Assistant to look at.',
    'NO_SCOPE_LINK');
}

router.post('/ask', async (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const body = req.body || {};
    const history = Array.isArray(body.history) ? body.history : [];
    const started = Date.now();

    const result = await ai.ask({
      collegeId,
      question: body.question,
      view: scopedView(req, body.view),
      history,
      timetableId: body.timetableId != null && body.timetableId !== '' ? Number(body.timetableId) : null,
    });

    res.json({ ...result, elapsedMs: Date.now() - started });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Test Connection
// ---------------------------------------------------------------------------
router.post('/test', requireCoordinator, async (req, res, next) => {
  try {
    // A candidate key may be supplied so the button works before saving.
    const candidate = req.body && req.body.key ? String(req.body.key) : null;
    if (candidate && !secrets.looksLikeOpenAiKey(candidate)) {
      throw httpError(400, 'That does not look like an OpenAI API key -- they begin with "sk-".', 'BAD_KEY_FORMAT');
    }
    const result = await ai.testConnection(candidate);
    res.json({ ...result, model: settings.getSetting('ai_model') });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
