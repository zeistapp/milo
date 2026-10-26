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

test("pages flattens keyed object pages into one array", () =>
  temporary("milo-pages-", async (bin) => {
    const previous = process.env.PATH;
    // A fake gh logs its arguments and prints two slurped check-runs pages.
    await Bun.write(
      join(bin, "gh"),
      `#!/bin/sh\necho "$@" > ${JSON.stringify(join(bin, "args"))}\necho '[{"total_count":3,"check_runs":[1,2]},{"total_count":3,"check_runs":[3]}]'\n`,
    );
    await command(["chmod", "+x", join(bin, "gh")]);
    try {
      process.env.PATH = `${bin}:${previous}`;
      expect(
        await new GitHub("o/r").pages("commits/abc/check-runs", "check_runs"),
      ).toEqual([1, 2, 3]);
      expect(await Bun.file(join(bin, "args")).text()).toBe(
        "api repos/o/r/commits/abc/check-runs?per_page=100 --paginate --slurp\n",
      );
      // Without a key, object pages are still rejected.
      await expect(new GitHub("o/r").pages("labels")).rejects.toThrow();
    } finally {
      process.env.PATH = previous;
    }
  }));
