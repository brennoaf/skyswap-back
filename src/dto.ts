import type { ObjectSummary, Post } from './kit.js'
import { mediaUrl } from './store.js'
import type { ObjectCardT, PostDtoT } from './schemas.js'

export function objectCard(o: ObjectSummary): ObjectCardT {
  return {
    id: o.id,
    handle: o.handle,
    name: o.name,
    kind: o.kind,
    avatar: mediaUrl(o.id, o.avatar),
    official_target: o.official_target,
    saturation: o.saturation,
    verdict: o.verdict,
    has_new_data: o.has_new_data,
    last_seen: o.last_seen,
  }
}

export function postDto(p: Post): PostDtoT {
  return {
    id: p.id,
    object_id: p.object_id,
    type: p.type,
    title: p.title,
    caption: p.caption,
    band: p.band,
    wavelength_um: p.wavelength_um,
    date_range: p.date_range,
    cover: mediaUrl(p.object_id, p.cover),
    frames: p.frames.map((f) => ({ ...f, src: mediaUrl(p.object_id, f.src) })),
    chart: p.chart ? mediaUrl(p.object_id, p.chart) : null,
    marks: p.marks,
    flags_summary: p.flags_summary,
  }
}
