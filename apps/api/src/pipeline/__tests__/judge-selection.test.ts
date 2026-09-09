import { describe, it, expect, vi, beforeEach } from "vitest";
import { STUDY_SLUGS } from "../../study/rotation.js";

// arenaPanelSlugs() is the whole contract of the admin selector: it turns a
// stored setting into the list of systems that will judge an arena pair.
// The DB is mocked because the resolution rule is what is under test, not
// drizzle.
const getJudgeModels = vi.fn(async (): Promise<string[] | null> => null);

vi.mock("../../settings.js", () => ({
  getJudgeModels: () => getJudgeModels(),
  isJudgeEnabled: async () => true,
}));
vi.mock("../../db/client.js", () => ({ db: {} }));

const { arenaPanelSlugs } = await import("../score-paper.js");

describe("arenaPanelSlugs", () => {
  beforeEach(() => getJudgeModels.mockReset());

  it("defaults to the full preregistered panel when nothing is chosen", async () => {
    getJudgeModels.mockResolvedValue(null);
    expect(await arenaPanelSlugs()).toEqual([...STUDY_SLUGS]);
  });

  it("returns the chosen subset", async () => {
    const subset = [STUDY_SLUGS[0]!, STUDY_SLUGS[3]!];
    getJudgeModels.mockResolvedValue(subset);
    const got = await arenaPanelSlugs();
    expect(new Set(got)).toEqual(new Set(subset));
    expect(got).toHaveLength(2);
  });

  it("treats an empty selection as no arena judging", async () => {
    getJudgeModels.mockResolvedValue([]);
    expect(await arenaPanelSlugs()).toEqual([]);
  });

  it("drops slugs that are not on the panel, so the setting cannot add a judge", async () => {
    getJudgeModels.mockResolvedValue([STUDY_SLUGS[1]!, "not-a-system", "gpt-9"]);
    expect(await arenaPanelSlugs()).toEqual([STUDY_SLUGS[1]!]);
  });

  it("returns panel order regardless of the order stored in the setting", async () => {
    const reversed = [...STUDY_SLUGS].reverse();
    getJudgeModels.mockResolvedValue(reversed);
    expect(await arenaPanelSlugs()).toEqual([...STUDY_SLUGS]);
  });
});
