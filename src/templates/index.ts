import type { BotTemplate } from "../runtime/context.js";
import { bookingTemplate } from "./booking/index.js";
import { broadcastTemplate } from "./broadcast/index.js";
import { contestTemplate } from "./contest/index.js";
import { faqTemplate } from "./faq/index.js";
import { kinoTemplate } from "./kino/index.js";
import { shopTemplate } from "./shop/index.js";
import { supportTemplate } from "./support/index.js";
import { surveyTemplate } from "./survey/index.js";

/** Order matters: this is the list users pick from, best sellers first. */
export const templateList: BotTemplate[] = [
  kinoTemplate,
  shopTemplate,
  broadcastTemplate,
  bookingTemplate,
  supportTemplate,
  contestTemplate,
  faqTemplate,
  surveyTemplate,
];

export const templates: Record<string, BotTemplate> = Object.fromEntries(
  templateList.map((t) => [t.key, t]),
);
