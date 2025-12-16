const API_BASE = 'https://api.w2g.tv';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function requireApiKey() {
  if (!process.env.W2G_API_KEY) {
    throw new Error('W2G_API_KEY is not set');
  }
  return process.env.W2G_API_KEY;
}

function youtubeIdFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1);
    }

    if (url.hostname.includes('youtube.com')) {
      if (url.searchParams.get('v')) {
        return url.searchParams.get('v');
      }
      const pathParts = url.pathname.split('/').filter(Boolean);
      // /shorts/<id> or /embed/<id> or /watch/<id>
      if (pathParts.length >= 2) {
        return pathParts[1];
      }
    }
  } catch (_) {
    return null;
  }

  return null;
}

function canonicalizeUrl(urlString) {
  const youtubeId = youtubeIdFromUrl(urlString);
  if (youtubeId) {
    try {
      const url = new URL(urlString);
      const t = url.searchParams.get('t') || url.searchParams.get('start');
      const canonical = new URL('https://www.youtube.com/watch');
      canonical.searchParams.set('v', youtubeId);
      if (t) {
        canonical.searchParams.set('t', t);
      }
      return canonical.toString();
    } catch (_) {
      // fall through to original
    }
  }

  return urlString;
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function scrapePageTitle(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resHtml = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (resHtml.ok) {
      const html = await resHtml.text();
      const ogTitleMatch = html.match(/<meta property="og:title" content="(.*?)"/);
      const titleMatch = html.match(/<title>(.*?)<\/title>/);
      let scrapedTitle = ogTitleMatch ? ogTitleMatch[1] : (titleMatch ? titleMatch[1] : null);

      if (scrapedTitle) {
        // Remove " - YouTube" suffix if present
        scrapedTitle = scrapedTitle.replace(/ - YouTube$/, '');
        return decodeHtmlEntities(scrapedTitle);
      }
    }
  } catch (err) {
    console.warn('Scraping fallback failed for', url, err);
  }
  return null;
}

async function fetchMetadata(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    let oembedUrl = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;

    // Prefer official YouTube oEmbed for YouTube links
    if (youtubeIdFromUrl(url)) {
      oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    }

    const res = await fetch(oembedUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      if (oembedUrl.includes('youtube.com/oembed')) {
        console.log('YouTube oEmbed failed, falling back to noembed...');
        const fallbackController = new AbortController();
        const fallbackTimer = setTimeout(() => fallbackController.abort(), 5000);
        try {
          const res2 = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, { signal: fallbackController.signal });
          clearTimeout(fallbackTimer);
          if (res2.ok) {
            const data = await res2.json();
            if (data.error || !data.title) {
              throw new Error('NoEmbed returned error or no title');
            }
            return {
              title: decodeHtmlEntities(data.title),
              thumbnail: data.thumbnail_url || data.thumbnail,
            };
          }
        } catch (err) {
          clearTimeout(fallbackTimer);
        }
      }
      throw new Error(`oEmbed failed with status ${res.status}`);
    } else {
      const data = await res.json();

      const meta = {
        title: decodeHtmlEntities(data.title),
        thumbnail: data.thumbnail_url || data.thumbnail,
      };

      if (!meta.thumbnail) {
        const youtubeId = youtubeIdFromUrl(url);
        if (youtubeId) {
          meta.thumbnail = `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;
        }
      }
      return meta;
    }
  } catch (err) {
    clearTimeout(timer);
    console.warn('Failed to fetch metadata via oEmbed for', url, err);

    // Fallback: Try to scrape the page title directly
    const scrapedTitle = await scrapePageTitle(url);
    if (scrapedTitle) {
      return {
        title: scrapedTitle,
        thumbnail: `https://img.youtube.com/vi/${youtubeIdFromUrl(url)}/hqdefault.jpg`
      };
    }
  }

  const youtubeId = youtubeIdFromUrl(url);
  if (youtubeId) {
    return { title: undefined, thumbnail: `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` };
  }

  return {};
}

async function createRoom(initialUrl) {
  const w2gApiKey = requireApiKey();
  const body = {
    w2g_api_key: w2gApiKey,
  };

  if (initialUrl) {
    body.share = initialUrl;
  }

  const res = await fetch(`${API_BASE}/rooms/create.json`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create room: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (!data.streamkey) {
    throw new Error('No streamkey returned from Watch2Gether');
  }

  return data.streamkey;
}

async function addToPlaylist(streamkey, url, title) {
  const w2gApiKey = requireApiKey();
  const cleanedUrl = canonicalizeUrl(url);
  const meta = await fetchMetadata(cleanedUrl);
  const resolvedTitle = title ?? meta.title;
  const body = {
    w2g_api_key: w2gApiKey,
    add_items: [
      {
        url: cleanedUrl,
        title: resolvedTitle || undefined,
        thumbnail: meta.thumbnail || undefined, // legacy param some clients use
        img: meta.thumbnail || undefined, // legacy param some clients use
        thumb: meta.thumbnail || undefined, // as per W2G API forum guidance
      },
    ],
  };

  const res = await fetch(
    `${API_BASE}/rooms/${encodeURIComponent(streamkey)}/playlists/current/playlist_items/sync_update`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to add to playlist: ${res.status} ${text}`);
  }
}

module.exports = {
  createRoom,
  addToPlaylist,
};
