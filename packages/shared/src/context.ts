export interface SelectionReference {
  text: string;
  pageUrl: string;
  pageTitle: string;
  capturedAt: string;
}

export interface PageContext {
  url: string;
  title: string;
  description?: string;
  visibleText?: string;
  fullText?: string;
  headings?: PageHeading[];
  links?: PageLink[];
  landmarks?: PageLandmark[];
  selection?: SelectionReference;
}

export interface PageHeading {
  level: number;
  text: string;
}

export interface PageLink {
  text: string;
  href: string;
}

export interface PageLandmark {
  tag: string;
  role?: string;
  label?: string;
  text?: string;
}

export type ContextScope = 'selection' | 'visible-page' | 'full-page';
