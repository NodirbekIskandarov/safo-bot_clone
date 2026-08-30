import type { BotTemplate } from "../runtime/context.js";
import { broadcastTemplate } from "./broadcast/index.js";
import { kinoTemplate } from "./kino/index.js";
import { shopTemplate } from "./shop/index.js";
import { surveyTemplate } from "./survey/index.js";

export const templateList: BotTemplate[] = [kinoTemplate, shopTemplate, broadcastTemplate, surveyTemplate];

export const templates: Record<string, BotTemplate> = Object.fromEntries(
  templateList.map((t) => [t.key, t]),
);
