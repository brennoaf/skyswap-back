import { Type } from '@fastify/type-provider-typebox'
import { UserDto } from './schemas.js'

const Code = (max: number) => Type.String({ minLength: 1, maxLength: max })

export const WebAuthnJson = Type.Record(Type.String(), Type.Unknown(), { description: 'WebAuthn JSON as produced by @simplewebauthn/browser' })

export const PasskeyOptions = Type.Object({ flow: Type.String(), options: WebAuthnJson })

export const PasskeyBody = Type.Object({ flow: Type.String({ maxLength: 64 }), response: WebAuthnJson })

export const OkResponse = Type.Object({ ok: Type.Boolean() })

export const RecoveryCode = Type.Object({ code: Type.String() })

export const RecoverBody = Type.Object({ nickname: Type.String({ minLength: 3, maxLength: 24 }), code: Code(40) })

export const RecoverResponse = Type.Object({ user: UserDto, code: Type.String() })

export const LinkCreated = Type.Object({ code: Type.String(), poll: Type.String(), expires_at: Type.Number() })

export const LinkCodeBody = Type.Object({ code: Code(20) })

export const LinkPollBody = Type.Object({ poll: Type.String({ minLength: 64, maxLength: 64 }) })

export const LinkInfo = Type.Object({ device: Type.String(), expires_at: Type.Number() })

export const LinkClaim = Type.Object({ status: Type.Union([Type.Literal('waiting'), Type.Literal('approved')]), user: Type.Union([UserDto, Type.Null()]) })

export const DeviceDto = Type.Object({
  id: Type.String(),
  device: Type.String({ description: 'system:browser, for example android:chrome or windows:edge' }),
  via: Type.Union([Type.Literal('nickname'), Type.Literal('passkey'), Type.Literal('qr'), Type.Literal('recovery')]),
  created_at: Type.Number(),
  last_seen: Type.Number(),
  current: Type.Boolean(),
  passkey: Type.Boolean(),
})

export const AccountResponse = Type.Object({ passkeys: Type.Integer(), recovery: Type.Boolean(), answers: Type.Integer(), devices: Type.Array(DeviceDto) })

export const RemoveDeviceResponse = Type.Object({ current: Type.Boolean() })
