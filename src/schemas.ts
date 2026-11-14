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

export const Story = Type.Object(
  {
    object: ObjectCard,
    post_id: Nullable(Type.String()),
    frames: Type.Array(Type.Object({ src: Type.String(), t: Type.String(), band: Type.String(), telescope: Nullable(Type.String()) })),
  },
  { $id: 'Story' },
)

export const StoriesResponse = Type.Object({ stories: Type.Array(Story) }, { $id: 'StoriesResponse' })

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
    measurements: Type.Object({ motion: Type.Optional(Type.String()), lightcurve: Type.Optional(Type.String()), spectra: Type.Optional(Type.String()) }),
    limits: Type.Array(Type.String()),
    field: Type.Object({ fov_deg: Type.Number(), ra: Nullable(Type.Number()), dec: Nullable(Type.Number()) }),
    pack: Nullable(Type.String()),
    overlays: Type.Object({ gaia: Nullable(Type.String()), wise: Nullable(Type.String()) }),
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

export const UserDto = Type.Object({ id: Type.String(), nickname: Type.String(), created_at: Type.Number() }, { $id: 'User' })

export const SessionResponse = Type.Object({ user: Nullable(UserDto) }, { $id: 'SessionResponse' })

export const SessionBody = Type.Object({ nickname: Type.String({ minLength: 3, maxLength: 24, pattern: '^[A-Za-z0-9_.]+$' }) })

export const DeckCardPublic = Type.Object(
  {
    id: Type.String(),
    sprite: Type.String(),
    n_frames: Type.Integer(),
    offsets_s: Type.Array(Type.Number()),
  },
  { $id: 'DeckCard' },
)

export const NextCardResponse = Type.Object({ done: Type.Boolean(), card: Nullable(DeckCardPublic), sky: Type.Boolean(), interesting: Type.Boolean() }, { $id: 'NextCardResponse' })

export const NextCardQuery = Type.Object({ explore: Type.Optional(Type.Boolean()), known: Type.Optional(Type.Boolean()) })

export const SkyCardBody = Type.Object({
  ra: Type.Number({ minimum: 0, maximum: 360 }),
  dec: Type.Number({ minimum: -90, maximum: 90 }),
  fov_deg: Type.Number({ minimum: 0.05, maximum: 0.2 }),
  band: Type.String({ pattern: '^D[1-6]$' }),
  size_px: Type.Integer({ minimum: 8, maximum: 400 }),
  frames: Type.Array(
    Type.Object({ key: Type.String({ maxLength: 200 }), mjd: Type.Number({ minimum: 50000, maximum: 80000 }), wl_um: Type.Number({ minimum: 0.5, maximum: 6 }), visit: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })) }),
    { minItems: 2, maxItems: 12 },
  ),
})

export const SkyCardResponse = Type.Object({ id: Type.String(), ra: Type.Number(), dec: Type.Number(), cell: Type.Integer(), offsets_s: Type.Array(Type.Number()) }, { $id: 'SkyCardResponse' })

export const ExploreCellsResponse = Type.Object({ order: Type.Integer(), cells: Type.Array(Type.Integer()) }, { $id: 'ExploreCellsResponse' })

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
})

export const GlitchBody = Type.Object({ glitch: Nullable(Type.Boolean()) })

export const GuideResponse = Type.Object({ card: Nullable(DeckCardPublic), marks: Type.Array(Type.Object({ u: Type.Number(), v: Type.Number() })) }, { $id: 'GuideResponse' })

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
    known: Nullable(Type.Object({ name: Type.String(), V: Nullable(Type.Number()), rate_arcsec_h: Nullable(Type.Number()) })),
    rate_arcsec_h: Nullable(Type.Number()),
    ra: Type.Number(),
    dec: Type.Number(),
    marks: Type.Array(Type.Object({ u: Type.Number(), v: Type.Number() })),
    control: Nullable(Type.Object({ truth: Type.String(), correct: Nullable(Type.Boolean()) })),
    p_real: Nullable(Type.Number()),
    votes: Type.Object({ real: Type.Integer(), artifact: Type.Integer(), unsure: Type.Integer() }),
    status: Type.String(),
  },
  { $id: 'Reveal' },
)

export const VoteResponse = Type.Object({ counted: Type.Boolean(), guided: Type.Boolean(), xp: XpDto, reveal: Reveal, new_badges: Type.Array(Type.String()) }, { $id: 'VoteResponse' })

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

export const SkyResponse = Type.Object(
  {
    ra: Type.Number(),
    dec: Type.Number(),
    fov: Type.Number(),
    band: Nullable(Type.String()),
    source: Type.String(),
    cell: Nullable(Type.Integer()),
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

export const HealthResponse = Type.Object(
  { ok: Type.Boolean(), version: Type.String(), objects: Type.Integer(), posts: Type.Integer(), cards: Type.Integer(), images_indexed: Type.Integer(), notes: Type.Array(Type.String()) },
  { $id: 'Health' },
)

export const ObjectsResponse = Type.Object({ objects: Type.Array(ObjectCard) }, { $id: 'ObjectsResponse' })
