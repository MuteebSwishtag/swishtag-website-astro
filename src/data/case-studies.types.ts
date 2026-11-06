export type CaseFeature = {
  label: string;
  title: string;
  body: string;
};

export type CaseSection = {
  kicker: string;
  title: string;
  body: string;
  image?: string;
  alt?: string;
};

export type ExploreCard = {
  name: string;
  href: string;
  image: string;
  category: string;
};

export type CaseDetail = {
  eyebrow: string;
  indexLabel: string;
  subtitle: string;
  intro: string;
  chips: string[];
  heroImage: string;
  heroAlt: string;
  facts: [string, string][];
  opportunityTitle: string;
  opportunity: string;
  capabilities: [string, string, string][];
  notice: string;
  sections: CaseSection[];
  explore: ExploreCard[];
};

export type CasePanel = {
  title: string;
  intro: string;
  opportunityTitle: string;
  opportunity: string;
  features: [string, string][];
  subtitle?: string;
  experienceTitle?: string;
  experience?: string;
  takeaway?: string;
  url?: string;
  status?: string;
  category?: string;
  industry?: string;
  platform?: string;
  logo?: string;
};

export type CaseProject = {
  slug: string;
  name: string;
  category: string;
  sourceCategory: string;
  image: string;
  gallery: string[];
  industry?: string;
  platform?: string;
  service?: string;
  panel?: CasePanel;
  detail?: CaseDetail;
};

export type CaseBrand = { name: string; image: string };
