const API_BASE = 'https://api.w2g.tv';

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

async function fetchMetadata(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(
      `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);

    if (!res.ok) return {};
    const data = await res.json();

    const meta = {
      title: data.title,
      thumbnail: data.thumbnail_url || data.thumbnail,
    };

    if (!meta.thumbnail) {
      const youtubeId = youtubeIdFromUrl(url);
      if (youtubeId) {
        meta.thumbnail = `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;
      }
    }

    return meta;
  } catch (err) {
    clearTimeout(timer);
    console.warn('Failed to fetch metadata for', url, err);
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
    headers: { 'Content-Type': 'application/json' },
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
  const body = {
    w2g_api_key: w2gApiKey,
    add_items: [
      {
        url: cleanedUrl,
        title: title || meta.title || undefined,
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
      headers: { 'Content-Type': 'application/json' },
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
