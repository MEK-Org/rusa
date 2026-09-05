/**
 * A principal is any identity that can appear in an attribution column. The
 * three kinds are the three that already appear there: actors, the people an
 * authenticated instance admits, and the mesh infrastructure's own writes.
 */
export type PrincipalKind = "actor" | "user" | "system";

/** The external identity a verified token yields. Email is never part of it. */
export interface ExternalIdentity {
  issuer: string;
  subject: string;
}

/**
 * An actor's identity. `id` is the actor id, unchanged — the ids already
 * written into attribution columns keep resolving as themselves.
 */
export interface ActorPrincipal {
  kind: "actor";
  id: string;
  actorId: string;
  createdAt: string;
}

/** Mesh infrastructure writing on its own behalf rather than for a peer. */
export interface SystemPrincipal {
  kind: "system";
  id: string;
  createdAt: string;
}

/** An admitted person. Absent `identity` means provisioned but not yet bound. */
export interface UserPrincipal {
  kind: "user";
  id: string;
  createdAt: string;
  /** Admission metadata, normalized to lowercase. Mutable; never the key. */
  email: string;
  /** The durable key, once a verified login has bound one. */
  identity?: ExternalIdentity;
  /** The user's own root actor, once one exists. */
  rootActorId?: string;
  /** Set to deny further access while the root and history are preserved. */
  disabledAt?: string;
  lastAuthenticatedAt?: string;
}

/**
 * A principal loaded from storage — the typed replacement for asking a string
 * what it is. A value of this type exists only because a row does, so a caller
 * holding one knows the identity is real and knows its kind.
 */
export type PrincipalRef = ActorPrincipal | UserPrincipal | SystemPrincipal;
