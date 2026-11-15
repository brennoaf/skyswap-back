import { Type, type Static, type TSchema } from '@fastify/type-provider-typebox'

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()])

export const ErrorBody = Type.Object({ error: Type.String() }, { $id: 'Error' })

export const ObjectCard = Type.Object(
  {
    id: Type.String(),
    handle: Type.String(),
    name: Type.String(),
    kind: Type.String(),
    avatar: Type.String(),
    official_target: Type.Boolean(),
    saturation: Type.String(),
    verdict: Type.String(),
    best_bands: Type.Array(Type.String()),
    has_new_data: Type.Boolean(),
    last_seen: Type.String(),
  },
  { $id: 'ObjectCard' },
)
export type ObjectCardT = Static<typeof ObjectCard>

export const FrameDto = Type.Object(
  {
    src: Type.String(),
    t: Type.String(),
    mjd: Type.Number(),
    band: Type.String(),
    wavelength_um: Nullable(Type.Array(Type.Number())),
    release: Type.String(),
    fov_deg: Type.Number(),
    kind: Type.String(),
    flags: Type.Object({ saturated_frac: Type.Number(), cosmic_ray: Type.Boolean(), satellite: Type.Boolean(), persistence: Type.Boolean() }),
    telescope: Nullable(Type.String()),
    n_exp: Nullable(Type.Integer()),
  },
  { $id: 'Frame' },
)

export const TagSummary = Type.Object(
  {
    mine: Type.Array(Type.String()),
    counts: Nullable(Type.Record(Type.String(), Type.Integer())),
  },
  { $id: 'TagSummary' },
)

export const PostDto = Type.Object(
  {
    id: Type.String(),
    object_id: Type.String(),
    type: Type.String(),
    title: Type.String(),
    caption: Type.String(),
    band: Nullable(Type.String()),
    wavelength_um: Nullable(Type.Array(Type.Number())),
    date_range: Type.Array(Type.String()),
    cover: Type.String(),
    frames: Type.Array(FrameDto),
    chart: Nullable(Type.String()),
    marks: Type.Array(Type.Object({ frame: Type.Integer(), x: Type.Number(), y: Type.Number() })),
    flags_summary: Type.Object({ saturated: Type.Number(), cosmic_ray: Type.Number(), satellite: Type.Number(), persistence: Type.Number() }),
  },
  { $id: 'Post' },
)
export type PostDtoT = Static<typeof PostDto>

export const FeedItem = Type.Object({ post: PostDto, object: ObjectCard, tags: TagSummary }, { $id: 'FeedItem' })

export const FeedResponse = Type.Object(
  {
    tab: Type.String(),
    items: Type.Array(FeedItem),
    next_cursor: Nullable(Type.Integer()),
    notice: Nullable(Type.String()),
  },
  { $id: 'FeedResponse' },
)

const StoryMark = Nullable(Type.Object({ x: Type.Number(), y: Type.Number() }))

export const StoryScreen = Type.Union(
  [
    Type.Object({
      kind: Type.Literal('blink'),
      topic: Type.Union([Type.Literal('years'), Type.Literal('passes'), Type.Literal('night'), Type.Literal('brightness')]),
      band: Nullable(Type.String()),
      wavelength_um: Nullable(Type.Number()),
      fixed: Type.Boolean(),
      frames: Type.Array(Type.Object({ src: Type.String(), t: Type.String(), telescope: Nullable(Type.String()), mark: StoryMark })),
    }),
    Type.Object({ kind: Type.Literal('still'), topic: Type.Literal('difference'), band: Nullable(Type.String()), src: Type.String(), hours: Nullable(Type.Number()) }),
    Type.Object({ kind: Type.Literal('curve'), band: Type.String(), saturated: Type.Boolean(), points: Type.Array(Type.Object({ t: Type.String(), mag: Type.Number(), err: Type.Number() })) }),
    Type.Object({
      kind: Type.Literal('colours'),
      reading: Type.Union([Type.Literal('measured'), Type.Literal('saturated'), Type.Literal('none')]),
      frames: Type.Array(Type.Object({ band: Type.String(), src: Type.String(), um: Nullable(Type.Array(Type.Number())), mark: StoryMark })),
      signal: Type.Array(Nullable(Type.Number())),
      features: Type.Array(Type.Object({ name_pt: Type.String(), name_en: Type.String() })),
    }),
    Type.Object({
      kind: Type.Literal('end'),
      motion: Nullable(Type.Object({ measured_arcsec: Type.Number(), err_arcsec: Type.Number(), predicted_arcsec: Type.Number(), days: Type.Number() })),
      images: Type.Integer(),
      passes: Type.Integer(),
    }),
  ],
  { $id: 'StoryScreen' },
)

export const Story = Type.Object({ object: ObjectCard, screens: Type.Array(StoryScreen) }, { $id: 'Story' })

export const StoriesResponse = Type.Object({ stories: Type.Array(Story), finds: Type.Array(Type.String()) }, { $id: 'StoriesResponse' })

export const ObjectProfileDto = Type.Object(
  {
    id: Type.String(),
    handle: Type.String(),
    name: Type.String(),
    aliases: Type.Array(Type.String()),
    kind: Type.String(),
    official_target: Type.Boolean(),
    ra: Type.Number(),
    dec: Type.Number(),
    epoch: Type.String(),
    pm_ra_cosdec: Nullable(Type.Number()),
    pm_dec: Nullable(Type.Number()),
    parallax: Nullable(Type.Number()),
    mags: Type.Record(Type.String(), Nullable(Type.Number())),
    saturation: Type.String(),
    saturation_source: Type.String(),
    verdict: Type.String(),
    best_bands: Type.Array(Type.String()),
    n_images: Type.Integer(),
    n_passes: Type.Integer(),
    first_seen: Type.String(),
    last_seen: Type.String(),
    avatar: Type.String(),
    has_new_data: Type.Boolean(),
    bio: Type.String(),
    facts: Type.Array(Type.Object({ label: Type.String(), value: Type.Union([Type.Number(), Type.String()]), unit: Nullable(Type.String()), source_id: Type.String() })),
    sources: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), url: Type.String() })),
    measurements: Type.Object({ motion: Type.Optional(Type.String()), lightcurve: Type.Optional(Type.String()), spectra: Type.Optional(Type.String()), features: Type.Optional(Type.String()), halo: Type.Optional(Type.String()) }),
    limits: Type.Array(Type.String()),
    field: Type.Object({ fov_deg: Type.Number(), ra: Nullable(Type.Number()), dec: Nullable(Type.Number()) }),
    pack: Nullable(Type.String()),
    overlays: Type.Object({ gaia: Nullable(Type.String()), wise: Nullable(Type.String()) }),
    finding: Nullable(Type.String()),
    stats: Type.Object({ posts: Type.Integer(), passes: Type.Integer(), followers: Type.Integer() }),
    following: Type.Boolean(),
  },
  { $id: 'ObjectProfile' },
)

export const ObjectPostsResponse = Type.Object({ posts: Type.Array(PostDto) }, { $id: 'ObjectPostsResponse' })

export const PostDetail = Type.Object(
  {
    post: PostDto,
    object: ObjectCard,
    tags: TagSummary,
    my_marks: Type.Array(Type.Object({ frame: Type.Integer(), x: Type.Number(), y: Type.Number() })),
    community_marks: Nullable(Type.Object({ people: Type.Integer(), frames: Type.Array(Type.Object({ frame: Type.Integer(), x: Type.Number(), y: Type.Number(), n: Type.Integer() })) })),
  },
  { $id: 'PostDetail' },
)

export const XpDto = Type.Object({ xp: Type.Integer(), streakBonus: Type.Integer(), streak: Type.Integer(), reason: Type.String() }, { $id: 'Xp' })

export const AvatarDto = Type.Object({ id: Type.String(), url: Type.String(), title: Type.String(), date: Nullable(Type.String()), credit: Type.String(), image_url: Type.String() })

export const UserDto = Type.Object({ id: Type.String(), nickname: Type.String(), created_at: Type.Number(), avatar: Nullable(AvatarDto) }, { $id: 'User' })

export const SessionResponse = Type.Object({ user: Nullable(UserDto) }, { $id: 'SessionResponse' })

export const SessionBody = Type.Object({ nickname: Type.String({ minLength: 3, maxLength: 24, pattern: '^[A-Za-z0-9_.]+$' }), avatar_id: Type.Optional(Type.String({ maxLength: 40 })) })

export const AvatarOfferQuery = Type.Object({ not: Type.Optional(Type.String({ maxLength: 1200 })) })

export const AvatarOffer = Type.Object({ avatars: Type.Array(AvatarDto) })

export const AvatarBody = Type.Object({ avatar_id: Type.String({ maxLength: 40 }) })

const deckCardFields = {
  id: Type.String(),
  sprite: Type.String(),
  n_frames: Type.Integer(),
  offsets_s: Type.Array(Type.Number()),
  t0: Type.String(),
}

export const DeckCardPublic = Type.Object(deckCardFields, { $id: 'DeckCard' })

const pair = <T extends TSchema>(t: T) => Type.Array(t, { minItems: 2, maxItems: 2 })

export const CardWcs = Type.Object({ ctype: pair(Type.String()), crval: pair(Type.Number()), crpix: pair(Type.Number()), cd: pair(pair(Type.Number())), naxis: pair(Type.Integer()) }, { $id: 'CardWcs' })

export const SkySpot = Type.Object(
  {
    id: Type.String(),
    ra: Type.Number(),
    dec: Type.Number(),
    fov_deg: Type.Number(),
    band: Type.String(),
    size_px: Type.Integer(),
    frames: Type.Array(Type.Object({ key: Type.String(), mjd: Type.Number(), wl_um: Type.Number(), visit: Type.Integer() })),
  },
  { $id: 'SkySpot', description: 'A sky card that already exists, in the shape POST /api/classify/sky takes. Build it and register it like a fresh one.' },
)

export const NextCardResponse = Type.Object({ done: Type.Boolean(), card: Nullable(DeckCardPublic), sky: Type.Boolean(), spot: Nullable(SkySpot) }, { $id: 'NextCardResponse' })

export const NextCardQuery = Type.Object({ explore: Type.Optional(Type.Boolean()), known: Type.Optional(Type.Boolean()), open: Type.Optional(Type.Boolean()), not: Type.Optional(Type.String({ maxLength: 200 })) })

export const SkyCardBody = Type.Object({
  ra: Type.Number({ minimum: 0, maximum: 360 }),
  dec: Type.Number({ minimum: -90, maximum: 90 }),
  fov_deg: Type.Number({ minimum: 0.05, maximum: 0.2 }),
  band: Type.String({ pattern: '^D[1-6]$' }),
  size_px: Type.Integer({ minimum: 8, maximum: 400 }),
  thumb: Type.Optional(Type.String({ maxLength: 30000, pattern: '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' })),
  frames: Type.Array(
    Type.Object({ key: Type.String({ maxLength: 200 }), mjd: Type.Number({ minimum: 50000, maximum: 80000 }), wl_um: Type.Number({ minimum: 0.5, maximum: 6 }), visit: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })) }),
    { minItems: 2, maxItems: 12 },
  ),
})

export const SkyCardResponse = Type.Object({ id: Type.String(), ra: Type.Number(), dec: Type.Number(), cell: Type.Integer(), offsets_s: Type.Array(Type.Number()) }, { $id: 'SkyCardResponse' })

export const ExploreCellsResponse = Type.Object({ order: Type.Integer(), cells: Type.Array(Type.Integer()), bytes: Type.Array(Type.Integer()), photo_bytes: Type.Array(Type.Integer()) }, { $id: 'ExploreCellsResponse' })

export const ExploreMapResponse = Type.Object(
  {
    order: Type.Integer(),
    indexed: Type.Integer(),
    cells: Type.Array(Type.Object({ cell: Type.Integer(), looks: Type.Integer() })),
    looks: Type.Integer(),
    people: Type.Integer(),
    mine: Type.Object({ cells: Type.Integer(), looks: Type.Integer() }),
  },
  { $id: 'ExploreMapResponse' },
)

export const CandidatesResponse = Type.Object(
  {
    candidates: Type.Array(
      Type.Object({
        id: Type.String(),
        ra: Type.Number(),
        dec: Type.Number(),
        fov_deg: Type.Number(),
        band: Type.String(),
        cell: Type.Integer(),
        p_real: Type.Number(),
        votes: Type.Object({ real: Type.Integer(), artifact: Type.Integer(), unsure: Type.Integer() }),
        frames: Type.Array(Type.Object({ key: Type.String(), t: Type.String(), mjd: Type.Number(), wl_um: Type.Number(), visit: Type.Integer() })),
        status: Type.String(),
        catalog_check: Type.Null(),
      }),
    ),
  },
  { $id: 'CandidatesResponse' },
)

export const VoteBody = Type.Object({
  card_id: Type.String({ maxLength: 64 }),
  choice: Type.Union([Type.Literal('moves'), Type.Literal('still'), Type.Literal('unsure')]),
  glitch: Type.Optional(Nullable(Type.Boolean())),
  position: Type.Optional(Type.Object({ frame: Type.Integer({ minimum: 0, maximum: 64 }), x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }) }, { additionalProperties: false })),
  held_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000 })),
  positions: Type.Optional(
    Type.Array(Nullable(Type.Object({ frame: Type.Integer({ minimum: 0, maximum: 64 }), x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }), ax: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), ay: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) }, { additionalProperties: false })), { maxItems: 64 }),
  ),
  think_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000 })),
  answered_at: Type.Optional(Type.Integer({ minimum: 0 })),
  hints: Type.Optional(Type.Boolean()),
})

export const SharedCardResponse = Type.Object({ card: DeckCardPublic, answered: Nullable(Type.Union([Type.Literal('moves'), Type.Literal('still'), Type.Literal('glitch'), Type.Literal('unsure')])) }, { $id: 'SharedCardResponse' })

export const CardShownBody = Type.Object({ card_id: Type.String({ maxLength: 64 }) })

export const GlitchBody = Type.Object({ glitch: Nullable(Type.Boolean()) })

export const GuideResponse = Type.Object({ lessons: Type.Array(Type.Object({ lesson: Type.Union([Type.Literal('moves'), Type.Literal('still'), Type.Literal('glitch')]), card: DeckCardPublic, marks: Type.Array(Type.Object({ u: Type.Number(), v: Type.Number() })) })), examples: Type.Array(Type.Object({ example: Type.Union([Type.Literal('still'), Type.Literal('moves'), Type.Literal('particle'), Type.Literal('streak')]), card: Type.Object(deckCardFields), marks: Type.Array(Type.Object({ u: Type.Number(), v: Type.Number() })) })) }, { $id: 'GuideResponse' })

export const Reveal = Type.Object(
  {
    your_choice: Type.Union([Type.Literal('moves'), Type.Literal('still'), Type.Literal('unsure')]),
    looked: Type.Integer(),
    outcome: Nullable(Type.Union([Type.Literal('open'), Type.Literal('moves'), Type.Literal('still'), Type.Literal('undecided')])),
    kind: Type.String(),
    band: Type.String(),
    size_arcmin: Type.Number(),
    tile: Type.Integer(),
    size_px: Type.Integer(),
    frames: Type.Array(Type.Object({ t: Type.String(), mjd: Type.Number(), n_exp: Type.Integer(), wl_min: Type.Number(), wl_max: Type.Number() })),
    known: Nullable(Type.Object({ name: Type.String(), object_id: Nullable(Type.String()), V: Nullable(Type.Number()), rate_arcsec_h: Nullable(Type.Number()) })),
    rate_arcsec_h: Nullable(Type.Number()),
    ra: Type.Number(),
    dec: Type.Number(),
    marks: Type.Array(Type.Object({ u: Type.Number(), v: Type.Number() })),
    control: Nullable(Type.Object({ truth: Type.String(), correct: Nullable(Type.Boolean()) })),
    p_real: Nullable(Type.Number({ description: 'Estimate, not a verdict: the chance that it moves, computed from the answers so far.' })),
    votes: Type.Object({ real: Type.Integer(), artifact: Type.Integer(), unsure: Type.Integer() }),
    status: Type.String(),
  },
  { $id: 'Reveal' },
)

export const VoteResponse = Type.Object({ counted: Type.Boolean(), guided: Type.Boolean(), xp: XpDto, reveal: Reveal, new_badges: Type.Array(Type.String()), first: Type.Boolean() }, { $id: 'VoteResponse' })

export const TagBody = Type.Object({ tag: Type.Union([Type.Literal('asteroid'), Type.Literal('artifact'), Type.Literal('brightness'), Type.Literal('unsure')]), on: Type.Boolean() })

export const TagResponse = Type.Object({ tags: TagSummary, xp: Nullable(XpDto) }, { $id: 'TagResponse' })

export const MarksBody = Type.Object({
  marks: Type.Array(Type.Object({ frame: Type.Integer({ minimum: 0, maximum: 500 }), x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }) }), { minItems: 1, maxItems: 200 }),
})

export const MarksResponse = Type.Object(
  {
    saved: Type.Integer(),
    xp: XpDto,
    new_badges: Type.Array(Type.String()),
    my_marks: Type.Array(Type.Object({ frame: Type.Integer(), x: Type.Number(), y: Type.Number() })),
    community_marks: Type.Object({ people: Type.Integer(), frames: Type.Array(Type.Object({ frame: Type.Integer(), x: Type.Number(), y: Type.Number(), n: Type.Integer() })) }),
  },
  { $id: 'MarksResponse' },
)

export const FollowBody = Type.Object({ on: Type.Boolean() })
export const FollowResponse = Type.Object({ following: Type.Boolean(), followers: Type.Integer(), xp: Nullable(XpDto) }, { $id: 'FollowResponse' })

export const LearnBody = Type.Object({ event: Type.Union([Type.Literal('band_seen'), Type.Literal('spectrum_opened'), Type.Literal('object_viewed')]), ref: Type.String({ maxLength: 80 }) })
export const LearnResponse = Type.Object({ new_badges: Type.Array(Type.String()) }, { $id: 'LearnResponse' })

export const MeResponse = Type.Object(
  {
    user: UserDto,
    xp: Type.Integer(),
    xp_today: Type.Integer(),
    daily_cap: Type.Integer(),
    streak: Type.Integer(),
    level: Type.Object({ level: Type.Integer(), key: Type.String(), min_xp: Type.Integer(), next_min_xp: Nullable(Type.Integer()), progress: Type.Number() }),
    levels: Type.Array(Type.Object({ level: Type.Integer(), key: Type.String(), min_xp: Type.Integer() })),
    badges: Type.Array(Type.Object({ key: Type.String(), earned_at: Nullable(Type.Number()) })),
    counts: Type.Object({ votes: Type.Integer(), marks: Type.Integer(), tags: Type.Integer(), following: Type.Integer() }),
    following: Type.Array(ObjectCard),
    history: Type.Array(
      Type.Object({
        type: Type.String(),
        ref: Type.String(),
        detail: Type.String(),
        created_at: Type.Number(),
        status: Nullable(Type.String()),
        post: Nullable(Type.Object({ id: Type.String(), title: Type.String(), object_id: Type.String(), cover: Type.String() })),
      }),
    ),
  },
  { $id: 'MeResponse' },
)

export const AlertsResponse = Type.Object(
  {
    alerts: Type.Array(
      Type.Object({
        id: Type.String(),
        type: Type.String(),
        ref: Type.String(),
        detail: Type.String(),
        created_at: Type.Number(),
        read: Type.Boolean(),
        object: Nullable(ObjectCard),
      }),
    ),
    unread: Type.Integer(),
  },
  { $id: 'AlertsResponse' },
)

export const AlertsReadBody = Type.Object({ ids: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 500 }) })

export const GoalsResponse = Type.Object({ goals: Type.Array(Type.Object({ key: Type.String(), target: Type.Integer(), count: Type.Integer(), month: Type.String() })) }, { $id: 'GoalsResponse' })

export const SpotDto = Type.Object(
  {
    name: Nullable(Type.String()),
    ra: Type.Number(),
    dec: Type.Number(),
    source: Type.String(),
    epoch: Nullable(Type.Number()),
    moved_arcsec: Nullable(Type.Number()),
    stale: Type.Boolean(),
    moving: Type.Boolean(),
  },
  { $id: 'Spot' },
)

export const SearchResponse = Type.Object(
  {
    query: Type.String(),
    objects: Type.Array(Type.Intersect([ObjectCard, Type.Object({ separation_deg: Nullable(Type.Number()) })])),
    spot: Nullable(SpotDto),
    resolved: Type.Boolean(),
  },
  { $id: 'SearchResponse' },
)

export const SkyQuery = Type.Object({
  ra: Type.Number({ minimum: 0, maximum: 360 }),
  dec: Type.Number({ minimum: -90, maximum: 90 }),
  fov: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1 })),
  band: Type.Optional(Type.String({ pattern: '^D[1-6]$' })),
})

export const PointChannel = Type.Object({
  band: Type.String(),
  wavelength_um: Type.Number(),
  wl_min_um: Type.Number(),
  wl_max_um: Type.Number(),
  value: Nullable(Type.Number()),
  hits: Type.Integer(),
  state: Type.Union([Type.Literal('ok'), Type.Literal('blank'), Type.Literal('empty'), Type.Literal('flagged')]),
  bright: Type.Boolean(),
})

export const PointSpectrum = Type.Object(
  {
    ra: Type.Number(),
    dec: Type.Number(),
    tile: Type.Integer(),
    pixel: pair(Type.Number()),
    pixel_arcsec: Type.Number(),
    date_beg: Nullable(Type.String()),
    date_end: Nullable(Type.String()),
    bright: Type.Boolean(),
    channels: Type.Array(PointChannel),
    object: Nullable(Type.Object({ id: Type.String(), name: Type.String(), at: Nullable(Type.String()), shift_arcsec: Type.Number(), solar_system: Type.Boolean() })),
    elsewhere: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), offset_arcsec: Type.Number() })),
  },
  { $id: 'PointSpectrum' },
)

export const SkyResponse = Type.Object(
  {
    ra: Type.Number(),
    dec: Type.Number(),
    fov: Type.Number(),
    band: Nullable(Type.String()),
    source: Type.Union([Type.Literal('fragment'), Type.Literal('sia'), Type.Literal('none')]),
    incomplete: Type.Boolean({ description: 'True when the archive could not be asked (offline) or did not answer for every collection: an empty or short list is then not proof that no image exists.' }),
    cell: Nullable(Type.Integer()),
    point_bytes: Nullable(Type.Integer()),
    total: Type.Integer(),
    releases: Type.Array(Type.String()),
    bands: Type.Record(Type.String(), Type.Integer()),
    images: Type.Array(
      Type.Object({
        key: Type.String(),
        release: Type.String(),
        band: Type.String(),
        mjd: Type.Number(),
        iso: Type.String(),
        lam_um: Nullable(Type.Number()),
        lam_min: Type.Number(),
        lam_max: Type.Number(),
        obs_id: Nullable(Type.String()),
        file_size: Nullable(Type.Integer()),
      }),
    ),
    nearby: Type.Array(Type.Intersect([ObjectCard, Type.Object({ separation_deg: Nullable(Type.Number()) })])),
    total_file_bytes: Nullable(Type.Integer()),
  },
  { $id: 'SkyResponse' },
)

export const IndexAtResponse = Type.Object(
  { cell: Type.Integer(), total: Type.Integer(), sampled: Type.Boolean(), rows: Type.Array(Type.Object({}, { additionalProperties: true })) },
  { $id: 'IndexAtResponse' },
)

export const HealthResponse = Type.Object(
  { ok: Type.Boolean(), version: Type.String(), objects: Type.Integer(), posts: Type.Integer(), cards: Type.Integer(), images_indexed: Type.Integer(), notes: Type.Array(Type.String()) },
  { $id: 'Health' },
)

export const ObjectsResponse = Type.Object({ objects: Type.Array(ObjectCard) }, { $id: 'ObjectsResponse' })

export const FindingSocial = Type.Object(
  {
    interesting: Type.Integer(),
    doubts: Type.Integer(),
    doubt_reasons: Type.Object({ image_defect: Type.Integer(), known_asteroid: Type.Integer(), variable_star: Type.Integer(), other: Type.Integer() }),
    also_seen: Type.Integer(),
    blind_answers: Type.Integer(),
    mine: Nullable(Type.Object({ interesting: Type.Boolean(), doubt: Nullable(Type.String()), second_look: Nullable(Type.String()), vote: Nullable(Type.String()), following: Type.Boolean() })),
  },
  { $id: 'FindingSocial' },
)

export const FindingSummary = Type.Object(
  {
    id: Type.String(),
    kind: Type.Union([Type.Literal('sky'), Type.Literal('deck')]),
    state: Type.String(),
    reason: Nullable(Type.String()),
    example: Type.Boolean(),
    ra: Type.Number(),
    dec: Type.Number(),
    band: Type.String(),
    sprite: Nullable(Type.String()),
    passes: Type.Integer(),
    first_t: Nullable(Type.String()),
    last_t: Nullable(Type.String()),
    updated_at: Type.Number(),
    checks_done: Type.Integer(),
    checks_total: Type.Integer(),
    credit_names: Type.Array(Type.String()),
    credit_others: Type.Integer(),
    first_vote: Nullable(Type.Object({ nickname: Nullable(Type.String()), at: Type.Number(), note: Nullable(Type.String()) })),
    social: FindingSocial,
    photo: Nullable(Type.String()),
    photo_cols: Type.Integer(),
    mark: Nullable(Type.Object({ x: Type.Number(), y: Type.Number() })),
    object_id: Nullable(Type.String()),
  },
  { $id: 'FindingSummary' },
)

export const CommunityFeed = Type.Object({ items: Type.Array(FindingSummary), next_cursor: Nullable(Type.Integer()) }, { $id: 'CommunityFeed' })

export const FindingDetail = Type.Object(
  {
    ...FindingSummary.properties,
      fov_deg: Type.Number(),
      offsets_s: Type.Array(Type.Number()),
      checks: Type.Array(Type.Object({ service: Type.String(), result: Nullable(Type.String()), names: Type.Array(Type.String()), note: Nullable(Type.String()), checked_at: Nullable(Type.Number()) })),
      events: Type.Array(Type.Object({ state: Type.String(), reason: Nullable(Type.String()), source: Type.String(), url: Nullable(Type.String()), data_version: Type.String(), created_at: Type.Number() })),
      credits: Type.Array(Type.String()),
      credits_anonymous: Type.Integer(),
      data_version: Type.String(),
      tracks: Nullable(
        Type.Object({
          people: Type.Integer(),
          you: Type.Boolean(),
          size_px: Type.Integer(),
          wcs: Nullable(CardWcs),
          spot: Nullable(SkySpot),
          frames: Type.Array(Type.Object({ mjd: Type.Number(), points: Type.Array(Type.Object({ u: Type.Number(), v: Type.Number() })), mine: Nullable(Type.Object({ u: Type.Number(), v: Type.Number() })) })),
        }),
      ),
  },
  { $id: 'FindingDetail' },
)

export const CommunityOverview = Type.Object({ open_cards: Type.Integer(), close_votes: Type.Integer(), highlight: Nullable(FindingSummary), has_popular: Type.Boolean() }, { $id: 'CommunityOverview' })

export const FindingPeople = Type.Object(
  {
    interesting: Type.Array(Type.String()),
    interesting_anonymous: Type.Integer(),
    doubts: Type.Array(Type.Object({ name: Type.String(), reason: Type.String() })),
    doubts_anonymous: Type.Integer(),
    also_seen: Type.Array(Type.String()),
    also_seen_anonymous: Type.Integer(),
  },
  { $id: 'FindingPeople' },
)

const DoubtReason = Type.Union([Type.Literal('image_defect'), Type.Literal('known_asteroid'), Type.Literal('variable_star'), Type.Literal('other')])

export const ReactionBody = Type.Object(
  {
    kind: Type.Union([Type.Literal('interesting'), Type.Literal('doubt')]),
    on: Type.Boolean(),
    reason: Type.Optional(DoubtReason),
    position: Type.Optional(Type.Object({ frame: Type.Integer({ minimum: 0, maximum: 64 }), x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }) }, { additionalProperties: false })),
  },
  { additionalProperties: false },
)

export const SecondLookBody = Type.Object({ choice: Type.Union([Type.Literal('moves'), Type.Literal('still'), Type.Literal('unsure')]) }, { additionalProperties: false })

export const FindingFollowBody = Type.Object({ on: Type.Boolean() }, { additionalProperties: false })

export const MyCards = Type.Object(
  {
    items: Type.Array(Type.Object({ card_id: Type.String(), label: Type.String(), created_at: Type.Number(), practice: Type.Boolean(), finding: Nullable(Type.String()), thumb: Nullable(Type.String()), thumb_cols: Type.Integer(), retired: Type.Boolean() })),
    next_cursor: Nullable(Type.Integer()),
  },
  { $id: 'MyCards' },
)

export const MyCardDetail = Type.Object({ label: Type.String(), reveal: Reveal, note: Nullable(Type.String()), note_editable: Type.Boolean() })

export const NoteBody = Type.Object({ note: Nullable(Type.String({ maxLength: 600 })) })

export const CreditResponse = Type.Object({ visible: Type.Boolean() }, { $id: 'CreditResponse' })
