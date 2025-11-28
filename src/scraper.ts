// src/scraper.ts
import axios from "axios";
import { Job } from "./types/Job";

function normalize(text: string): string {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function parsePostedAt(raw?: string): Date | null {
  if (!raw) return null;
  const txt = raw.toLowerCase();
  const now = new Date();

  const m = txt.match(/(\d+)/);
  const n = m ? parseInt(m[1], 10) : 0;
  if (!n) return null;

  if (txt.includes("hour")) {
    const d = new Date(now);
    d.setHours(d.getHours() - n);
    return d;
  }
  if (txt.includes("day")) {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d;
  }
  if (txt.includes("week")) {
    const d = new Date(now);
    d.setDate(d.getDate() - n * 7);
    return d;
  }

  return null;
}

function detectUrgent(title: string, description?: string): boolean {
  const txt = normalize(`${title} ${description ?? ""}`);
  return (
    txt.includes("urgente") ||
    txt.includes("urgent") ||
    txt.includes("contratacion inmediata") ||
    txt.includes("contratacion urgente") ||
    txt.includes("inmediata") ||
    txt.includes("se busca urgente") ||
    txt.includes("urgentemente")
  );
}

/**
 * Busca empleos usando SerpAPI (Google Jobs)
 * @param keyword  Ej: "quimico farmaceutico"
 * @param location Ej: "Bogota, Colombia"
 */
export async function scrapeJobs(
  keyword: string,
  location: string
): Promise<Job[]> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.error("ERROR: Falta SERPAPI_KEY en .env");
    return [];
  }

  try {
    const { data } = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "google_jobs",
        q: keyword,
        location: location,
        hl: "es",
        gl: "co",
        api_key: apiKey
      }
    });

    const results: any[] = data.jobs_results || [];
    if (!results.length) {
      console.warn("SerpAPI devolvió 0 resultados");
      return [];
    }

    const jobs: Job[] = results.map((j) => {
      const detected = j.detected_extensions || {};

      const title: string = j.title || "Título desconocido";
      const company: string =
        j.company_name || j.via || "Empresa no especificada";
      const loc: string = j.location || location;
      const desc: string | undefined = j.description;

      const link: string =
        j.apply_options?.[0]?.link ||
        j.related_links?.[0]?.link ||
        "https://www.google.com/search?q=" + encodeURIComponent(title);

      const postedAt = parsePostedAt(detected.posted_at);
      const urgent = detectUrgent(title, desc);

      let salaryMin: number | undefined;
      let salaryMax: number | undefined;
      let salaryRaw: string | undefined;

      if (detected.salary_from || detected.salary_to || detected.salary) {
        salaryMin = detected.salary_from;
        salaryMax = detected.salary_to;
        salaryRaw =
          detected.salary ||
          `${detected.salary_from || ""}-${detected.salary_to || ""}`;
      }

      const job: Job = {
        title,
        company,
        location: loc,
        link,
        source: j.via || "Google Jobs",
        salaryMin,
        salaryMax,
        salaryRaw,
        isSalaryConfidential: !salaryMin && !salaryMax,
        description: desc,
        postedAt,
        urgent
      };

      return job;
    });

    return jobs;
  } catch (err) {
    console.error("Error al llamar a SerpAPI:", err);
    return [];
  }
}
