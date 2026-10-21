import { expect, test } from "bun:test";
import { join } from "node:path";
import { author, GitHub } from "../src/github.ts";
import { command, temporary } from "../src/process.ts";

test("Milo acts and commits as its App's bot, or as the token owner without one", () =>
  temporary("milo-identity-", async (bin) => {
    const previous = {
      MILO_APP_SLUG: process.env.MILO_APP_SLUG,
      PATH: process.env.PATH,
    };
    // A fake gh answers both user lookups, so this checks which one Milo asks.
    await Bun.write(
      join(bin, "gh"),
      `#!/bin/sh\ncase "$2" in user) echo '{"login":"owner"}' ;; users/milo-app%5Bbot%5D) echo '{"id":7}' ;; *) exit 1 ;; esac\n`,
    );
    await command(["chmod", "+x", join(bin, "gh")]);
    try {
      process.env.PATH = `${bin}:${previous.PATH}`;
      delete process.env.MILO_APP_SLUG;
      expect(await new GitHub("o/r").viewer()).toBe("owner");
      expect(await author()).toEqual([
        "github-actions[bot]",
        "41898282+github-actions[bot]@users.noreply.github.com",
      ]);
      process.env.MILO_APP_SLUG = "milo-app";
      expect(await new GitHub("o/r").viewer()).toBe("milo-app[bot]");
      expect(await author()).toEqual([
        "milo-app[bot]",
        "7+milo-app[bot]@users.noreply.github.com",
      ]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }));
