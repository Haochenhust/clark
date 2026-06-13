import type { Element, IconElement, PlainTextElement } from "./elements";

export interface CardConfig {
  streaming_mode?: boolean;
  width_mode?: "fill" | "compact";
  use_custom_translation?: boolean;
  enable_forward?: boolean;
  enable_forward_interaction?: boolean;
  update_multi?: boolean;
  summary: {
    content: string;
  };
}

export interface CardHead {
  icon?: IconElement;
  title: PlainTextElement;
  subtitle?: PlainTextElement;
  template?:
    | "default"
    | "blue"
    | "wathet"
    | "turquoise"
    | "green"
    | "yellow"
    | "orange"
    | "red"
    | "carmine"
    | "violet"
    | "purple"
    | "indigo"
    | "grey";
  padding?: string;
}

export interface CardBody {
  direction?: "vertical" | "horizontal";
  padding?: string;
  horizontal_spacing?: string;
  horizontal_align?: "left" | "center" | "right";
  vertical_spacing?: string;
  elements: Element[];
}

export interface Card {
  schema: "2.0";
  config?: CardConfig;
  /** Feishu card 2.0 root header. NOTE: the JSON key must be `header` (not `head`). */
  header?: CardHead;
  body: CardBody;
}
