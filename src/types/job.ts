// src/types/Job.ts

export interface Job {
  title: string;
  company: string;
  location: string;
  link: string;
  source: string;

  salaryMin?: number;
  salaryMax?: number;
  salaryRaw?: string;
  isSalaryConfidential?: boolean;

  description?: string;

  postedAt?: Date | null;
  urgent?: boolean;
}
