// The shared SkillStore suite (stream F) against the real registry store.
import { describeSkillStoreConformance } from "@oneseat/testkit";
import { createSkillStore } from "../src/index.js";

describeSkillStoreConformance(({ storeDir }) => createSkillStore({ dataDir: storeDir }));
