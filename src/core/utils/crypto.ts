import { createHash } from "crypto";

export function hashUsingSha256(str: string): string {
    const hash = createHash('sha256');
    hash.update(str);
    return hash.digest('hex');
  }