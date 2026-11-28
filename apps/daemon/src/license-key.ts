// Public half of OneSeat Cloud's license signing key (ed25519). The private half exists
// only in the Render service's LICENSE_PRIVATE_KEY. Rotating it means shipping a new app.
export const ONESEAT_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAHMTAs9IlQqzrB49G9zNn3j329MYNwopRF6CquE7ZHFY=
-----END PUBLIC KEY-----
`;

/** OneSeat Cloud. Override with ONESEAT_CLOUD_URL (staging, local testing). */
export const DEFAULT_CLOUD_URL = "https://oneseat-cloud.onrender.com";
