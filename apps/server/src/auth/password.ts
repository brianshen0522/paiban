import { hash, verify } from '@node-rs/argon2';

/** argon2id with the library's defaults, stored as a PHC string (docs/12-auth.md, "Passwords"). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

// A real hash of a random value, verified against when the username does not exist, so the answer
// takes as long as a wrong password and does not reveal which accounts exist.
let dummy: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummy ??= hash(crypto.randomUUID());
  return dummy;
}

export async function verifyPassword(phc: string | null, password: string): Promise<boolean> {
  if (!phc) {
    await verify(await dummyHash(), password).catch(() => false);
    return false;
  }
  return verify(phc, password).catch(() => false);
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
