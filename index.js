const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const { request, gql } = require('graphql-request');

const app  = express();
const PORT = 3000;

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ─── HTTP client ──────────────────────────────────────────────────────────────
const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: '*/*',
  },
});

// ─── In-memory cache ──────────────────────────────────────────────────────────
const _cache = new Map();
function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { _cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttlMs = 6 * 60 * 60 * 1000) {
  _cache.set(key, { value, expires: Date.now() + ttlMs });
}

// ─── AniList ──────────────────────────────────────────────────────────────────
const ANILIST_API = 'https://graphql.anilist.co';
const ANILIST_QUERY = gql`
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id idMal
      title { romaji english native }
      synonyms
      startDate { year month day }
      externalLinks { url site }
    }
  }
`;

async function fetchAnilistMedia(anilistId) {
  const key = `anilist_${anilistId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await request(ANILIST_API, ANILIST_QUERY, { id: parseInt(anilistId) });
  const media = data?.Media || null;
  if (media) cacheSet(key, media, 24 * 60 * 60 * 1000);
  return media;
}

// ─── External ID extraction ───────────────────────────────────────────────────
const EXTERNAL_ID_RULES = [
  { key: 'tmdb', sites: ['themoviedb', 'tmdb'], pattern: /themoviedb\.org\/tv\/(\d+)/ },
  { key: 'tvdb', sites: ['thetvdb', 'tvdb'],    pattern: /thetvdb\.com\/series\/([^\/?#]+)/ },
  { key: 'mal',  sites: ['myanimelist'],         pattern: /myanimelist\.net\/anime\/(\d+)/ },
];

function extractExternalIds(media) {
  const ids = {
    anilist: media.id    ? String(media.id)    : null,
    mal:     media.idMal ? String(media.idMal) : null,
  };
  for (const link of media.externalLinks || []) {
    const url  = link.url  || '';
    const site = (link.site || '').toLowerCase();
    for (const rule of EXTERNAL_ID_RULES) {
      if (ids[rule.key]) continue;
      if (!rule.sites.some((s) => site.includes(s) || url.toLowerCase().includes(s))) continue;
      const m = url.match(rule.pattern);
      if (m) { ids[rule.key] = m[1]; break; }
    }
  }
  return Object.fromEntries(Object.entries(ids).filter(([, v]) => v != null));
}

// ─── 123animes slug search ────────────────────────────────────────────────────
const BASE = 'https://w1.123animes.ru';

function toSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function slugVariations(title) {
  const base = toSlug(title);
  const set  = new Set([base]);
  set.add(base + '-tv');
  set.add(base + '-dub');
  set.add(base + '-sub');
  set.add(base + '-english-dub');
  set.add(base + '-ova');
  set.add(base + '-ona');
  const stripped = base.replace(/-season-\d+$/, '').replace(/-part-\d+$/, '').replace(/-\d+$/, '');
  set.add(stripped);
  set.add(stripped + '-tv');
  return [...set].filter(s => s.length > 1);
}

async function checkSlugExists(slug) {
  try {
    const r = await http.get(`${BASE}/anime/${slug}`, {
      headers: { Referer: 'https://www.google.com/' },
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (r.status !== 200) return false;
    const html = typeof r.data === 'string' ? r.data : '';
    const lowerHtml = html.toLowerCase();
    return (
      lowerHtml.includes(`/anime/${slug}`) ||
      lowerHtml.includes('data-id') ||
      lowerHtml.includes('episode') ||
      lowerHtml.includes('watch-now')
    );
  } catch { return false; }
}

async function search123Slug(titles) {
  const asciiTitles = titles.filter(t => t && !/[^\x00-\x7F]/.test(t));

  // Strategy 1 — try direct slug + common variations
  for (const title of asciiTitles) {
    for (const slug of slugVariations(title)) {
      if (await checkSlugExists(slug)) {
        console.log(`[123animes] Direct slug hit: "${slug}" (from "${title}")`);
        return slug;
      }
    }
  }

  // Strategy 2 — site search
  for (const title of asciiTitles) {
    try {
      const { data } = await http.get(`${BASE}/?s=${encodeURIComponent(title)}`, {
        headers: { Referer: 'https://www.google.com/' },
      });
      const $ = cheerio.load(data);

      const allAnimeLinks = new Map();
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/anime\/([^\/\?#]+)/);
        if (!m) return;
        const slug = m[1];
        if (['list', 'filter', 'search'].includes(slug) || slug.length < 2) return;
        const text = $(el).text().trim();
        if (!allAnimeLinks.has(slug)) allAnimeLinks.set(slug, text);
      });

      console.log(`[123animes] Search "${title}" found ${allAnimeLinks.size} links`);

      if (!allAnimeLinks.size) continue;

      const titleLower = title.toLowerCase();
      const titleSlug  = toSlug(title);
      const titleWords = titleLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);

      const scored = Array.from(allAnimeLinks.entries()).map(([slug, text]) => {
        const sSlug = slug.toLowerCase();
        const sText = text.toLowerCase();
        let score = 0;
        if (sSlug === titleSlug)                  score += 200;
        else if (sSlug.startsWith(titleSlug))     score += 100;
        else if (sSlug.includes(titleSlug))       score += 60;
        if (sText === titleLower)                 score += 150;
        else if (sText.includes(titleLower))      score += 50;
        const matched = titleWords.filter(w => sSlug.includes(w) || sText.includes(w));
        score += (matched.length / Math.max(titleWords.length, 1)) * 40;
        return { slug, text, score };
      }).sort((a, b) => b.score - a.score);

      console.log(`[123animes] Best match: "${scored[0]?.slug}" (score ${scored[0]?.score}) text="${scored[0]?.text}"`);

      if (scored[0]?.score >= 15) return scored[0].slug;

    } catch (e) {
      console.warn(`[123animes] Search "${title}" failed:`, e.message);
    }
  }

  return null;
}

// ─── 123animes scraping ───────────────────────────────────────────────────────
async function fetchEpisodeList(slug) {
  const ts = Date.now();
  const { data } = await http.get(`${BASE}/ajax/film/sv?id=${slug}&ts=001&_=${ts}`, {
    headers: { Referer: `${BASE}/anime/${slug}`, 'X-Requested-With': 'XMLHttpRequest' },
  });

  const html = typeof data === 'object' ? (data.html || data.content || '') : data;
  const $    = cheerio.load(html);
  const episodes = [];

  $('a[data-id]').each((_, el) => {
    const $a    = $(el);
    const base  = $a.attr('data-base');
    const href  = $a.attr('href');
    const num   = parseInt(base || $a.text().trim(), 10);
    const parts = ($a.attr('data-id') || '').split('/');
    const epSlug = parts[0] || slug;
    const epNum  = parts[1] || String(num);
    const liId   = $a.closest('li').attr('id');

    if (!isNaN(num)) {
      episodes.push({
        episode:   num,
        label:     `Episode ${num}`,
        slug:      epSlug,
        episodeId: `${epSlug}/episode/${epNum}`,
        url:       href ? `${BASE}${href}` : '',
        m3u8:      `https://hlsx3cdn.echovideo.to/${epSlug}/${epNum}/master.m3u8`,
        isFirst:   liId === 'str',
        isLast:    liId === 'end',
      });
    }
  });

  return episodes;
}

async function scrapeAnimePage(slug) {
  const { data: html } = await http.get(`${BASE}/anime/${slug}`, {
    headers: { Referer: 'https://www.google.com/' },
  });
  const $ = cheerio.load(html);
  const result = { slug };

  result.title =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') || '';

  result.cover =
    $('meta[property="og:image"]').attr('content') ||
    $('img[src*="/imgs/poster/"]').first().attr('src') || '';
  if (result.cover?.startsWith('/')) result.cover = BASE + result.cover;

  result.synopsis = $('meta[property="og:description"]').attr('content') || '';

  result.genres = [];
  $('a[href*="/genere/"]').each((_, el) => {
    const g = $(el).text().trim();
    if (g && !result.genres.includes(g)) result.genres.push(g);
  });

  result.info = {};
  $('dl dt').each((_, dt) => {
    const key = $(dt).text().replace(':', '').trim();
    const val = $(dt).next('dd').text().trim();
    if (key && val) result.info[key] = val;
  });

  result.episodes      = await fetchEpisodeList(slug);
  result.totalEpisodes = result.episodes.length;
  return result;
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY || '699be86b7a4ca2c8bc77525cb4938dc0';

async function searchTMDBByTitle(title) {
  try {
    const r = await http.get(`${TMDB_API}/search/tv`, {
      params: { api_key: TMDB_KEY, query: title, page: 1 },
    });
    const results = r.data?.results || [];
    if (!results.length) return null;
    const best = results.reduce((a, b) => (b.vote_count ?? 0) > (a.vote_count ?? 0) ? b : a);
    console.log(`[TMDB] Search "${title}" → "${best.name}" (id ${best.id})`);
    return best.id?.toString() || null;
  } catch (e) {
    console.error('[TMDB] Search failed:', e.message);
    return null;
  }
}

async function fetchTMDBEpisodes(seriesId, targetYear = null) {
  const cacheKey = `tmdb_eps_${seriesId}_${targetYear || 'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const seriesRes = await http.get(`${TMDB_API}/tv/${seriesId}`, {
      params: { api_key: TMDB_KEY },
    });
    const seasons = (seriesRes.data?.seasons || []).filter(
      (s) => s.season_number > 0 && s.episode_count > 0
    );
    console.log(`[TMDB] Series ${seriesId} "${seriesRes.data.name}" — ${seasons.length} seasons`);

    if (targetYear) {
      const exact   = seasons.find((s) => s.air_date && parseInt(s.air_date, 10) === targetYear);
      const matched = exact || seasons.find((s) => {
        if (!s.air_date) return false;
        return Math.abs(parseInt(s.air_date, 10) - targetYear) === 1;
      });
      if (matched) {
        console.log(`[TMDB] targetYear=${targetYear} → Season ${matched.season_number} (${matched.air_date})`);
        const r = await http.get(`${TMDB_API}/tv/${seriesId}/season/${matched.season_number}`, {
          params: { api_key: TMDB_KEY },
        });
        const eps = (r.data?.episodes || []).map((ep, idx) => ({ ...ep, absoluteNumber: idx + 1 }));
        cacheSet(cacheKey, eps);
        return eps;
      }
      console.warn(`[TMDB] No season matched year=${targetYear}, fetching all`);
    }

    const seasonResults = await Promise.all(
      seasons.map((s) =>
        http.get(`${TMDB_API}/tv/${seriesId}/season/${s.season_number}`, { params: { api_key: TMDB_KEY } })
          .then((r) => r.data?.episodes || [])
          .catch(() => [])
      )
    );
    const allEps = [];
    let abs = 1;
    for (const eps of seasonResults)
      for (const ep of eps) allEps.push({ ...ep, absoluteNumber: abs++ });

    console.log(`[TMDB] Total: ${allEps.length} episodes for series ${seriesId}`);
    cacheSet(cacheKey, allEps);
    return allEps;
  } catch (e) {
    console.error('[TMDB] fetchTMDBEpisodes failed:', e.message);
    return [];
  }
}

function buildTMDBLookup(tmdbEps) {
  const map = new Map();
  for (const ep of tmdbEps) {
    if (ep.absoluteNumber == null) continue;
    map.set(Number(ep.absoluteNumber), {
      title:         ep.name         || null,
      overview:      ep.overview     || null,
      airDate:       ep.air_date     || null,
      aired:         ep.air_date ? new Date(ep.air_date) <= new Date() : null,
      rating:        ep.vote_average != null ? String(ep.vote_average) : null,
      thumbnail:     ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
      seasonNumber:  ep.season_number  ?? null,
      episodeNumber: ep.episode_number ?? null,
    });
  }
  return map;
}

function mergeEpisodesWithTMDB(episodes, lookup) {
  return episodes.map((ep) => {
    const meta = lookup.get(Number(ep.episode));
    if (!meta) return ep;
    return {
      ...ep,
      ...(meta.title         != null && { title:         meta.title }),
      ...(meta.overview      != null && { overview:      meta.overview }),
      ...(meta.airDate       != null && { airDate:       meta.airDate }),
      ...(meta.aired         != null && { aired:         meta.aired }),
      ...(meta.rating        != null && { rating:        meta.rating }),
      ...(meta.thumbnail     != null && { thumbnail:     meta.thumbnail }),
      ...(meta.seasonNumber  != null && { seasonNumber:  meta.seasonNumber }),
      ...(meta.episodeNumber != null && { episodeNumber: meta.episodeNumber }),
    };
  });
}

// ─── Route: GET / ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'Anime API',
    version: '1.0.0',
    endpoints: {
      details: {
        method: 'GET',
        path: '/details/anime/:anilistId',
        description: 'Fetch anime details + episode list with TMDB enrichment',
        example: '/details/anime/11757',
      },
      watch: {
        method: 'GET',
        path: '/watch/anime/:slug/episode/:episode',
        description: 'Get M3U8 stream URLs for a specific episode',
        example: '/watch/anime/sword-art-online/episode/1',
      },
      debug: {
        method: 'GET',
        path: '/debug/slug/:anilistId',
        description: 'Diagnose slug resolution for an anime',
        example: '/debug/slug/11757',
      },
    },
    examples: {
      sao:         '/details/anime/11757',
      aot:         '/details/anime/16498',
      demonSlayer: '/details/anime/166240',
    },
  });
});

// ─── Route: GET /details/anime/:anilistId ─────────────────────────────────────
app.get('/details/anime/:anilistId', async (req, res) => {
  const { anilistId } = req.params;

  try {
    // 1 — AniList metadata
    const media = await fetchAnilistMedia(anilistId);
    if (!media) return res.status(404).json({ success: false, error: 'AniList ID not found' });

    const externalIds = extractExternalIds(media);
    const allTitles   = [
      media.title?.english,
      media.title?.romaji,
      media.title?.native,
      ...(media.synonyms || []),
    ].filter(Boolean);

    // 2 — Find slug on 123animes (cached)
    const slugCacheKey = `slug_123_${anilistId}`;
    let slug = cacheGet(slugCacheKey);
    if (!slug) {
      slug = await search123Slug(allTitles);
      if (slug) cacheSet(slugCacheKey, slug, 24 * 60 * 60 * 1000);
    }
    if (!slug) {
      return res.status(404).json({
        success: false,
        error: 'Could not find this anime on 123animes',
        anilistId,
        searchedTitles: allTitles,
      });
    }

    // 3 — Scrape 123animes
    const data = await scrapeAnimePage(slug);

    // 4 — TMDB enrichment
    let tmdbId = externalIds.tmdb || null;
    if (!tmdbId) {
      const t = media.title?.english || media.title?.romaji;
      if (t) tmdbId = await searchTMDBByTitle(t);
    }
    if (tmdbId) {
      const targetYear = media.startDate?.year || null;
      const tmdbEps    = await fetchTMDBEpisodes(tmdbId, targetYear);
      if (tmdbEps.length) {
        const lookup  = buildTMDBLookup(tmdbEps);
        data.episodes = mergeEpisodesWithTMDB(data.episodes, lookup);
        data.enriched     = true;
        data.metaSource   = 'tmdb';
        data.tmdbSeriesId = tmdbId;
      }
    } else {
      data.enriched = false;
    }

    // 5 — Attach identifiers
    data.anilistId   = parseInt(anilistId);
    data.externalIds = externalIds;

    res.json({ success: true, data });
  } catch (err) {
    console.error('[route] error:', err.message);
    res.status(500).json({ success: false, anilistId, error: err.message });
  }
});

// ─── Route: GET /debug/slug/:anilistId ───────────────────────────────────────
app.get('/debug/slug/:anilistId', async (req, res) => {
  const { anilistId } = req.params;
  try {
    const media = await fetchAnilistMedia(anilistId);
    if (!media) return res.status(404).json({ error: 'AniList ID not found' });

    const allTitles = [
      media.title?.english, media.title?.romaji,
      media.title?.native, ...(media.synonyms || []),
    ].filter(Boolean);

    const asciiTitles = allTitles.filter(t => !/[^\x00-\x7F]/.test(t));
    const slugsToTry  = asciiTitles.flatMap(slugVariations);

    const slugChecks = await Promise.all(
      [...new Set(slugsToTry)].map(async (slug) => ({
        slug,
        exists: await checkSlugExists(slug),
        url: `${BASE}/anime/${slug}`,
      }))
    );

    res.json({
      anilistId,
      titles: { english: media.title?.english, romaji: media.title?.romaji },
      asciiTitles,
      slugChecks,
      hits: slugChecks.filter(s => s.exists),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Route: GET /watch/anime/:slug/episode/:episode ──────────────────────────
app.get('/watch/anime/:slug/episode/:episode', async (req, res) => {
  const { slug, episode } = req.params;
  try {
    const m3u8Url  = `https://hlsx3cdn.echovideo.to/${slug}/${episode}/master.m3u8`;
    const { data } = await http.get(m3u8Url, {
      headers: { Referer: `${BASE}/anime/${slug}/episode/${episode}`, Origin: 'https://hlsx3cdn.echovideo.to' },
    });

    const lines = data.split('\n').map((l) => l.trim()).filter(Boolean);
    const streams = [];
    let meta = {};
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const attrs = {};
        const re = /(\w[\w-]*)=("([^"]+)"|([^,\s]+))/g;
        let m;
        while ((m = re.exec(line)) !== null) attrs[m[1]] = m[3] ?? m[4];
        meta = attrs;
      } else if (!line.startsWith('#') && meta.BANDWIDTH) {
        streams.push({ ...meta, url: line.startsWith('http') ? line : new URL(line, m3u8Url).href });
        meta = {};
      }
    }

    res.json({ success: true, slug, episode: parseInt(episode, 10), episodeId: `${slug}/episode/${episode}`, source: m3u8Url, streamCount: streams.length, streams });
  } catch (err) {
    res.status(500).json({ success: false, slug, episode, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nServer running → http://localhost:${PORT}`);
  console.log('\nEndpoints:');
  console.log('  GET /                                → API info & endpoint list');
  console.log('  GET /details/anime/:anilistId        → auto-find on 123animes + TMDB enrichment');
  console.log('  GET /watch/anime/:slug/episode/:ep   → M3U8 streams');
  console.log('  GET /debug/slug/:anilistId           → diagnose slug resolution');
  console.log('\nExamples:');
  console.log('  http://localhost:3000/details/anime/11757    (SAO)');
  console.log('  http://localhost:3000/details/anime/16498    (AoT)');
  console.log('  http://localhost:3000/details/anime/166240   (Demon Slayer Hashira Training)\n');
});
