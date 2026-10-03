/** Reserved admission metadata for the auth-disabled zero-user bootstrap.
 * This address never names an admitted login. The first verified named login
 * replaces it atomically while preserving the durable principal id. */
export const IMPLICIT_USER_EMAIL = "local-operator@rusa.invalid";
