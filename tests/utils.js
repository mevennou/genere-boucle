// Lecture des fixtures de parite produites par tests/parite.py
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ICI = dirname(fileURLToPath(import.meta.url));

export function lecture(nom) {
  return JSON.parse(readFileSync(join(ICI, "fixtures", nom), "utf-8"));
}
