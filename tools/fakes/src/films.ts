import { createHash } from 'node:crypto';

/**
 * The fake YTS catalogue: the prototype's 14 public-domain films (prototype/platform/src/app1.js),
 * in YTS's own shape. Hashes are made up but stable; a version can be pointed at a file the local
 * seeder really serves (`LocalVersion`), which is how the offline download test works.
 */
type V = [
  quality: string,
  type: string,
  codec: string,
  bitDepth: number,
  audio: string,
  gb: number,
  seeds: number,
  peers: number,
];
type Film = {
  id: number;
  slug: string;
  title: string;
  year: number;
  min: number;
  genres: string[];
  rating: number;
  plot: string;
  v: V[];
};

const F: Film[] = [
  {
    id: 1,
    slug: 'notld',
    title: 'Night of the Living Dead',
    year: 1968,
    min: 96,
    genres: ['Horror'],
    rating: 7.8,
    plot: 'Strangers barricade a farmhouse against the dead.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.88, 412, 38],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.6, 655, 61],
      ['2160p', 'bluray', 'x265', 10, '5.1', 5.9, 188, 24],
    ],
  },
  {
    id: 2,
    slug: 'charade',
    title: 'Charade',
    year: 1963,
    min: 113,
    genres: ['Comedy', 'Mystery', 'Romance'],
    rating: 7.9,
    plot: 'A widow is chased by three men after a missing fortune.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 1.0, 301, 22],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.9, 498, 47],
      ['1080p', 'bluray', 'x265', 10, '5.1', 1.2, 96, 11],
    ],
  },
  {
    id: 3,
    slug: 'hisgirl',
    title: 'His Girl Friday',
    year: 1940,
    min: 92,
    genres: ['Comedy', 'Romance'],
    rating: 7.8,
    plot: 'An editor keeps his star reporter with one last story.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.83, 144, 12],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.5, 207, 19],
    ],
  },
  {
    id: 4,
    slug: 'lastman',
    title: 'The Last Man on Earth',
    year: 1964,
    min: 86,
    genres: ['Horror', 'Sci-Fi'],
    rating: 6.7,
    plot: 'The only man left alive after a plague.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.79, 88, 9],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.5, 131, 17],
    ],
  },
  {
    id: 5,
    slug: 'metropolis',
    title: 'Metropolis',
    year: 1927,
    min: 153,
    genres: ['Sci-Fi', 'Drama'],
    rating: 8.3,
    plot: 'A city split between the idle rich and the workers below.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 1.3, 320, 26],
      ['1080p', 'bluray', 'x264', 8, '2.0', 2.7, 541, 52],
      ['2160p', 'bluray', 'x265', 10, '5.1', 6.8, 163, 30],
    ],
  },
  {
    id: 6,
    slug: 'stranger',
    title: 'The Stranger',
    year: 1946,
    min: 95,
    genres: ['Crime', 'Film-Noir'],
    rating: 7.3,
    plot: 'A war criminal hides as a small-town teacher.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.87, 97, 8],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.7, 152, 14],
    ],
  },
  {
    id: 7,
    slug: 'scarlet',
    title: 'Scarlet Street',
    year: 1945,
    min: 102,
    genres: ['Film-Noir', 'Drama'],
    rating: 7.7,
    plot: 'A cashier falls for the wrong woman.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.93, 76, 7],
      ['1080p', 'bluray', 'x265', 10, '2.0', 1.1, 58, 9],
    ],
  },
  {
    id: 8,
    slug: 'shop',
    title: 'The Little Shop of Horrors',
    year: 1960,
    min: 72,
    genres: ['Comedy', 'Horror'],
    rating: 6.2,
    plot: 'A plant with one kind of appetite.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.66, 64, 5],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.2, 91, 8],
    ],
  },
  {
    id: 9,
    slug: 'plan9',
    title: 'Plan 9 from Outer Space',
    year: 1957,
    min: 79,
    genres: ['Sci-Fi', 'Horror'],
    rating: 3.9,
    plot: 'Aliens raise the dead.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.72, 119, 10],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.3, 170, 16],
    ],
  },
  {
    id: 10,
    slug: 'carnival',
    title: 'Carnival of Souls',
    year: 1962,
    min: 78,
    genres: ['Horror', 'Mystery'],
    rating: 7.0,
    plot: 'The only survivor of a crash is drawn to an abandoned pavilion.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.7, 83, 6],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.3, 126, 13],
    ],
  },
  {
    id: 11,
    slug: 'haunted',
    title: 'House on Haunted Hill',
    year: 1959,
    min: 75,
    genres: ['Horror', 'Mystery'],
    rating: 6.7,
    plot: 'A night in a haunted house for ten thousand dollars.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.69, 102, 9],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.3, 0, 2],
    ],
  },
  {
    id: 12,
    slug: 'general',
    title: 'The General',
    year: 1926,
    min: 78,
    genres: ['Action', 'Comedy'],
    rating: 8.1,
    plot: 'An engineer chases his stolen locomotive.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.71, 211, 15],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.3, 344, 29],
    ],
  },
  {
    id: 13,
    slug: 'nosferatu',
    title: 'Nosferatu',
    year: 1922,
    min: 94,
    genres: ['Horror', 'Fantasy'],
    rating: 7.8,
    plot: 'An estate agent brings a count home.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.85, 266, 21],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.5, 389, 35],
    ],
  },
  {
    id: 14,
    slug: 'doa',
    title: 'D.O.A.',
    year: 1949,
    min: 83,
    genres: ['Film-Noir', 'Mystery'],
    rating: 7.2,
    plot: 'A man reports his own murder.',
    v: [
      ['720p', 'bluray', 'x264', 8, '2.0', 0.76, 59, 4],
      ['1080p', 'bluray', 'x264', 8, '2.0', 1.4, 84, 7],
    ],
  },
];

/** A version backed by a file the local seeder serves. */
export type LocalVersion = {
  ytsId: number;
  quality: string;
  type: string;
  videoCodec: string;
  bitDepth: number;
  audio: string;
  hash: string;
  sizeBytes: number;
};

export type YtsMovieJson = Record<string, unknown> & {
  id: number;
  title: string;
  year: number;
  rating: number;
  genres: string[];
  torrents: Record<string, unknown>[];
  date_uploaded_unix: number;
};

const fakeHash = (s: string) => createHash('sha1').update(`paiban-fake:${s}`).digest('hex').toUpperCase();

export function catalogue(baseUrl: string, local: LocalVersion[] = []): YtsMovieJson[] {
  return F.map((f, i) => {
    const uploaded = 1_700_000_000 + (F.length - i) * 86_400;
    const torrents = f.v.map(([quality, type, codec, bit, audio, gb, seeds, peers], k) => {
      const override = local.find(
        (l) => l.ytsId === f.id && l.quality === quality && l.videoCodec === codec && l.bitDepth === bit,
      );
      const size = override?.sizeBytes ?? Math.round(gb * 1024 ** 3);
      return {
        url: `${baseUrl}/torrent/download/${fakeHash(`${f.slug}:${k}`)}`,
        hash: override?.hash.toUpperCase() ?? fakeHash(`${f.slug}:${k}`),
        quality,
        type,
        is_repack: '0',
        video_codec: codec,
        bit_depth: String(bit),
        audio_channels: audio,
        seeds,
        peers,
        size: `${gb} GB`,
        size_bytes: size,
        date_uploaded: new Date(uploaded * 1000).toISOString().slice(0, 19).replace('T', ' '),
        date_uploaded_unix: uploaded,
      };
    });
    // Seeded files that match none of the film's versions (SEED_EXTRA_FILM) are listed after them.
    for (const l of local) {
      if (l.ytsId !== f.id || f.v.some(([q, , c, b]) => q === l.quality && c === l.videoCodec && b === l.bitDepth))
        continue;
      const gb = Math.round((l.sizeBytes / 1024 ** 3) * 100) / 100;
      torrents.push({
        url: `${baseUrl}/torrent/download/${l.hash.toUpperCase()}`,
        hash: l.hash.toUpperCase(),
        quality: l.quality,
        type: l.type,
        is_repack: '0',
        video_codec: l.videoCodec,
        bit_depth: String(l.bitDepth),
        audio_channels: l.audio,
        seeds: 1,
        peers: 0,
        size: `${gb} GB`,
        size_bytes: l.sizeBytes,
        date_uploaded: new Date(uploaded * 1000).toISOString().slice(0, 19).replace('T', ' '),
        date_uploaded_unix: uploaded,
      });
    }
    return {
      id: f.id,
      url: `${baseUrl}/movies/${f.slug}`,
      imdb_code: `tt${String(9_000_000 + f.id).padStart(7, '0')}`,
      title: f.title,
      title_english: f.title,
      title_long: `${f.title} (${f.year})`,
      slug: `${f.slug}-${f.year}`,
      year: f.year,
      rating: f.rating,
      runtime: f.min,
      genres: f.genres,
      summary: f.plot,
      description_full: f.plot,
      yt_trailer_code: '',
      language: 'en',
      mpa_rating: '',
      // Points at this fake server, which answers 404: the web app then draws its placeholder poster.
      medium_cover_image: `${baseUrl}/assets/images/movies/${f.slug}/medium-cover.jpg`,
      state: 'ok',
      torrents,
      date_uploaded_unix: uploaded,
    };
  });
}

/**
 * What a fake TMDB knows about the same films (Chinese titles and plots from the prototype). The
 * rating is set a little apart from YTS's IMDb figure, so a page shows which one it used.
 */
const ZH: Record<string, [title: string, plot: string, color: string]> = {
  notld: ['活死人之夜', '一群陌生人躲進鄉間農舍，門外是不斷聚集的活死人，屋裡的人卻先吵了起來。', '#3a2c2c'],
  charade: ['謎中謎', '丈夫離奇身亡後，一筆失蹤的鉅款讓她被三個男人追著跑，唯一幫她的人身分卻一變再變。', '#7a2f3a'],
  hisgirl: ['小報妙冤家', '報社主編想留住準備再婚的前妻兼王牌記者，最好的辦法就是丟給她一條大新聞。', '#2f4a6b'],
  lastman: ['地球最後一人', '瘟疫過後只剩他一個活人，白天獵殺、夜裡死守，日復一日過了三年。', '#4a4f39'],
  metropolis: ['大都會', '未來都市分成地上的享樂者與地下的勞工，一個機器人被造出來挑起兩邊的衝突。', '#8a6a1f'],
  stranger: ['陌生人', '戰犯化名躲在小鎮當老師，追查他的調查員只有一條線索：他對鐘錶的著迷。', '#26323d'],
  scarlet: ['血紅街道', '中年出納員迷上年輕女子，被她和情人一步步騙走了畫作、積蓄與人生。', '#8c2b22'],
  shop: ['恐怖小店', '花店小店員養的怪植物只吃一種東西，而且胃口越來越大。', '#2f5a3c'],
  plan9: ['外太空九號計劃', '外星人為了阻止人類造出毀滅性武器，決定讓死人復活。', '#3d2f63'],
  carnival: ['', '車禍中唯一生還的女子搬到新城市，卻不斷被一座廢棄遊樂場和一張蒼白的臉吸引。', '#4b4b55'],
  haunted: ['', '富翁邀五個陌生人到鬧鬼的大宅過夜，撐到天亮的人各得一萬美元。', '#5a3d1e'],
  general: ['將軍號', '南北戰爭中，火車司機單槍匹馬去追被搶走的火車頭，和車上的未婚妻。', '#6b4a2a'],
  nosferatu: ['吸血鬼', '房地產經紀人遠赴古堡簽約，把一位不該請進城的伯爵帶回了家鄉。', '#1f3a3a'],
  doa: ['', '他走進警局報案：被謀殺的人是他自己，毒發前只剩幾天找出兇手。', '#2c2c33'],
};

export type TmdbFake = {
  imdb: string;
  tmdbId: number;
  title: string;
  originalTitle: string;
  overview: string;
  voteAverage: number;
  voteCount: number;
  posterPath: string;
  color: string;
};

export function tmdbCatalogue(): TmdbFake[] {
  return F.map((f) => {
    const [zh, plot, color] = ZH[f.slug] ?? ['', '', '#333333'];
    return {
      imdb: `tt${String(9_000_000 + f.id).padStart(7, '0')}`,
      tmdbId: 900_000 + f.id,
      title: zh || f.title,
      originalTitle: f.title,
      overview: plot,
      voteAverage: Math.round((f.rating - 0.4) * 10) / 10,
      voteCount: 500 + f.id * 37,
      posterPath: `/fake-${f.slug}.png`,
      color,
    };
  });
}
