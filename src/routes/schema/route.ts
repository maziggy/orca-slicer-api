import express from "express";
import { getSchema } from "./schema.service";

const router = express.Router();

// GET /schema
//   What settings the bundled slicer actually supports. Bambuddy validates
//   user overrides against `keys` — the two slicers genuinely differ (545 on
//   BambuStudio, 572 on OrcaSlicer, 394 in common), so a hand-maintained
//   list on the caller's side would accept settings this binary ignores.
router.get("/", async (req, res, next) => {
  try {
    res.status(200).json(await getSchema());
  } catch (error) {
    next(error);
  }
});

export default router;
