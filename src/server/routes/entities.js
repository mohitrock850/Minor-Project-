'use strict';

/**
 * Generic entity CRUD (Section 1).
 *
 * One router serves every entity in the registry. The registry decides which
 * fields exist, crud.js decides what a role may do with them, and the renderer
 * builds its list and form screens from the same definitions -- so adding a
 * field is a one-line change that shows up everywhere at once.
 */

const express = require('express');
const { listRows, getRow, createRow, updateRow, deleteRow } = require('../services/crud');
const { getEntity } = require('../services/entityRegistry');

const router = express.Router();

router.get('/:entity', (req, res, next) => {
  try {
    const entity = getEntity(req.params.entity);
    const result = listRows(req, entity.key, req.query);
    res.json({ entity: entity.key, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/:entity/:id', (req, res, next) => {
  try {
    const entity = getEntity(req.params.entity);
    res.json(getRow(req, entity.key, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/:entity', (req, res, next) => {
  try {
    const entity = getEntity(req.params.entity);
    res.status(201).json(createRow(req, entity.key, req.body || {}));
  } catch (err) {
    next(err);
  }
});

router.patch('/:entity/:id', (req, res, next) => {
  try {
    const entity = getEntity(req.params.entity);
    res.json(updateRow(req, entity.key, Number(req.params.id), req.body || {}));
  } catch (err) {
    next(err);
  }
});

// PUT behaves like PATCH: the renderer sends whole forms, and a partial update is
// always the safer interpretation for a screen that may not know every column.
router.put('/:entity/:id', (req, res, next) => {
  try {
    const entity = getEntity(req.params.entity);
    res.json(updateRow(req, entity.key, Number(req.params.id), req.body || {}));
  } catch (err) {
    next(err);
  }
});

router.delete('/:entity/:id', (req, res, next) => {
  try {
    const entity = getEntity(req.params.entity);
    res.json(deleteRow(req, entity.key, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
