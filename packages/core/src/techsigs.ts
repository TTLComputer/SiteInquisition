/**
 * Built-in technology signatures. Each one is plain data: where to look
 * (a response header, a cookie, the host, the HTML) and how sure a match
 * makes us. Users add their own in the same shape, and can reject, pin or
 * disable any of these per project, so a wrong guess is one click to fix.
 *
 * Detection is passive: these only ever read traffic that was already
 * captured. Probes under `checks` are sent only when the user clicks them.
 */

export type TechCategory = 'cloud' | 'cdn' | 'hosting' | 'server' | 'language' | 'framework' | 'frontend' | 'cms' | 'auth' | 'protocol' | 'security';

export type MatchIn =
  /** A response header; `name` is the header (glob), `match` a regex on its value. */
  | 'header'
  /** A request header. */
  | 'requestHeader'
  /** A cookie the server set or the client sent; `name` is a glob on the cookie name. */
  | 'cookie'
  | 'host'
  | 'path'
  /** The response body when it is text (first 256 KB). */
  | 'body'
  /** The request body when it is text (first 64 KB). */
  | 'requestBody';

export interface Matcher {
  in: MatchIn;
  /** Header or cookie name, case-insensitive, `*` wildcards. */
  name?: string;
  /** Case-insensitive regex on the value (or on the host, path or body). Absent means "is present". */
  match?: string;
  /** How sure one match makes us, 0 to 1. Default 0.8. Several matches combine. */
  weight?: number;
}

export interface CsrfSink {
  /** Where the client sends the token back. */
  in: 'header' | 'form' | 'json' | 'query';
  name: string;
}

export interface CsrfSource {
  /** Where the server hands the token out. */
  from: 'cookie' | 'header' | 'meta' | 'input' | 'json' | 'regex';
  /** Cookie, header, meta name, input name, JSON key, or (for "regex") a regex whose first group is the token. */
  name: string;
  /** Undo URL encoding before use (Laravel and Spring put an encoded token in XSRF-TOKEN). */
  urlDecode?: boolean;
}

export interface CsrfPattern {
  source: CsrfSource;
  sinks: CsrfSink[];
}

export interface TechCheck {
  /** What to look for and why, shown next to the technology. */
  text: string;
  /** An optional request the user can choose to send. Never sent automatically. */
  probe?: { method: 'GET' | 'HEAD' | 'OPTIONS'; path: string };
}

export interface Signature {
  id: string;
  name: string;
  category: TechCategory;
  /** The provider behind a family of signatures (all the AWS services), so lists can group them. */
  vendor?: string;
  matchers: Matcher[];
  /** Technologies this one implies (Next.js implies React and Node.js). */
  implies?: string[];
  /** Cookies that belong to the platform, not the app (load balancer stickiness, bot management). */
  infraCookies?: Array<{ name: string; reason: string }>;
  csrf?: CsrfPattern[];
  checks?: TechCheck[];
  /** Link to the platform's docs. */
  docs?: string;
}

const h = (name: string, match?: string, weight?: number): Matcher => ({ in: 'header', name, ...(match ? { match } : {}), ...(weight !== undefined ? { weight } : {}) });
const rh = (name: string, match?: string, weight?: number): Matcher => ({ in: 'requestHeader', name, ...(match ? { match } : {}), ...(weight !== undefined ? { weight } : {}) });
const c = (name: string, weight?: number, match?: string): Matcher => ({ in: 'cookie', name, ...(match ? { match } : {}), ...(weight !== undefined ? { weight } : {}) });
const host = (match: string, weight = 0.95): Matcher => ({ in: 'host', match, weight });
const path = (match: string, weight?: number): Matcher => ({ in: 'path', match, ...(weight !== undefined ? { weight } : {}) });
const body = (match: string, weight?: number): Matcher => ({ in: 'body', match, ...(weight !== undefined ? { weight } : {}) });
const server = (match: string, weight = 0.95) => h('server', match, weight);
const poweredBy = (match: string, weight = 0.95) => h('x-powered-by', match, weight);

const LIST: Signature[] = [
  // ---------- AWS ----------
  { id: 'aws', name: 'AWS', category: 'cloud', matchers: [h('x-amzn-requestid', undefined, 0.7), h('x-amz-request-id', undefined, 0.6), h('x-amzn-trace-id', undefined, 0.6), h('x-amzn-errortype', undefined, 0.8), rh('authorization', '^AWS4-HMAC-SHA256', 0.95)] },
  {
    id: 'aws-cloudfront',
    name: 'Amazon CloudFront',
    category: 'cdn',
    implies: ['aws'],
    matchers: [h('x-amz-cf-id', undefined, 0.95), h('x-amz-cf-pop', undefined, 0.95), h('via', 'cloudfront', 0.9), h('x-cache', 'cloudfront', 0.9), host('\\.cloudfront\\.net$')],
  },
  {
    id: 'aws-elb',
    name: 'AWS load balancer (ALB/ELB)',
    category: 'cloud',
    implies: ['aws'],
    matchers: [c('AWSALB*', 0.95), c('AWSELB', 0.95), server('^awselb', 0.95), host('\\.elb\\.amazonaws\\.com$')],
    infraCookies: [
      { name: 'AWSALB*', reason: 'AWS load balancer stickiness' },
      { name: 'AWSELB', reason: 'AWS classic load balancer stickiness' },
    ],
  },
  {
    id: 'aws-api-gateway',
    name: 'Amazon API Gateway',
    category: 'cloud',
    implies: ['aws'],
    matchers: [h('x-amz-apigw-id', undefined, 0.95), host('\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com$'), h('x-amzn-errortype', '^(UnauthorizedException|ForbiddenException|MissingAuthenticationTokenException|AccessDeniedException)', 0.6)],
    docs: 'https://docs.aws.amazon.com/apigateway/',
  },
  { id: 'aws-lambda-url', name: 'AWS Lambda function URL', category: 'cloud', implies: ['aws'], matchers: [host('\\.lambda-url\\.[a-z0-9-]+\\.on\\.aws$')] },
  {
    id: 'aws-s3',
    name: 'Amazon S3',
    category: 'cloud',
    implies: ['aws'],
    matchers: [server('^AmazonS3$'), h('x-amz-id-2', undefined, 0.7), host('(^|\\.)s3([.-][a-z0-9-]+)?\\.amazonaws\\.com$'), { in: 'path', match: '[?&]X-Amz-Signature=', weight: 0.6 }],
  },
  { id: 'aws-appsync', name: 'AWS AppSync', category: 'cloud', implies: ['aws'], matchers: [host('\\.appsync-api\\.[a-z0-9-]+\\.amazonaws\\.com$'), host('\\.appsync-realtime-api\\.')] },
  { id: 'aws-amplify', name: 'AWS Amplify Hosting', category: 'hosting', implies: ['aws'], matchers: [host('\\.amplifyapp\\.com$', 0.9)] },
  {
    id: 'aws-cognito',
    name: 'Amazon Cognito',
    category: 'auth',
    implies: ['aws'],
    matchers: [host('^cognito-idp\\.[a-z0-9-]+\\.amazonaws\\.com$'), host('\\.auth\\.[a-z0-9-]+\\.amazoncognito\\.com$'), rh('x-amz-target', '^AWSCognitoIdentityProviderService\\.', 0.95), c('cognito', 0.6)],
  },

  // ---------- Cloudflare and other CDNs, WAFs ----------
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'cdn',
    matchers: [server('^cloudflare$'), h('cf-ray', undefined, 0.95), h('cf-cache-status', undefined, 0.85), c('__cf_bm', 0.9), c('cf_clearance', 0.9), c('__cflb', 0.9), c('_cfuvid', 0.9)],
    infraCookies: [
      { name: '__cf_bm', reason: 'Cloudflare bot management' },
      { name: 'cf_clearance', reason: 'Cloudflare challenge passed' },
      { name: '__cflb', reason: 'Cloudflare load balancer affinity' },
      { name: '_cfuvid', reason: 'Cloudflare rate limiting' },
      { name: '__cfruid', reason: 'Cloudflare rate limiting' },
    ],
    checks: [{ text: 'A 403 or 503 with a "Just a moment..." page is a Cloudflare challenge, not your app. Pass it in the built-in browser and replay with fresh cookies.' }],
  },
  { id: 'cloudflare-pages', name: 'Cloudflare Pages', category: 'hosting', implies: ['cloudflare'], matchers: [host('\\.pages\\.dev$', 0.9)] },
  { id: 'cloudflare-workers', name: 'Cloudflare Workers', category: 'hosting', implies: ['cloudflare'], matchers: [host('\\.workers\\.dev$', 0.9)] },
  { id: 'fastly', name: 'Fastly', category: 'cdn', matchers: [h('x-fastly-request-id', undefined, 0.95), h('x-served-by', '^cache-', 0.7), h('fastly-*', undefined, 0.8)] },
  {
    id: 'akamai',
    name: 'Akamai',
    category: 'cdn',
    matchers: [server('^AkamaiGHost'), h('x-akamai-transformed', undefined, 0.9), h('akamai-grn', undefined, 0.9), c('ak_bmsc', 0.9), c('bm_sv', 0.8), c('bm_sz', 0.8), c('_abck', 0.9)],
    infraCookies: [
      { name: 'ak_bmsc', reason: 'Akamai bot manager' },
      { name: 'bm_*', reason: 'Akamai bot manager' },
      { name: '_abck', reason: 'Akamai bot manager' },
    ],
  },
  { id: 'varnish', name: 'Varnish', category: 'cdn', matchers: [h('x-varnish', undefined, 0.85), h('via', 'varnish', 0.8)] },
  {
    id: 'f5-bigip',
    name: 'F5 BIG-IP',
    category: 'server',
    matchers: [c('BIGipServer*', 0.95), c('TS01*', 0.5), server('^BigIP', 0.9)],
    infraCookies: [
      { name: 'BIGipServer*', reason: 'F5 load balancer persistence' },
      { name: 'TS01*', reason: 'F5 ASM session' },
    ],
  },
  {
    id: 'imperva',
    name: 'Imperva (Incapsula)',
    category: 'security',
    matchers: [c('visid_incap_*', 0.95), c('incap_ses_*', 0.95), h('x-iinfo', undefined, 0.9), h('x-cdn', 'incapsula', 0.9)],
    infraCookies: [
      { name: 'visid_incap_*', reason: 'Imperva visitor id' },
      { name: 'incap_ses_*', reason: 'Imperva session' },
      { name: 'nlbi_*', reason: 'Imperva load balancer' },
    ],
  },
  { id: 'datadome', name: 'DataDome', category: 'security', matchers: [c('datadome', 0.95), h('x-datadome*', undefined, 0.95)], infraCookies: [{ name: 'datadome', reason: 'DataDome bot protection' }] },

  // ---------- Google Cloud and Firebase ----------
  { id: 'gcp', name: 'Google Cloud', category: 'cloud', matchers: [h('via', '1\\.1 google', 0.8), h('x-cloud-trace-context', undefined, 0.8), server('^Google Frontend$', 0.9), c('GCLB', 0.9)], infraCookies: [{ name: 'GCLB', reason: 'Google Cloud load balancer affinity' }] },
  { id: 'gcp-cloud-run', name: 'Cloud Run', category: 'hosting', implies: ['gcp'], matchers: [host('\\.run\\.app$')] },
  { id: 'gcp-app-engine', name: 'App Engine', category: 'hosting', implies: ['gcp'], matchers: [host('\\.appspot\\.com$')] },
  { id: 'gcp-functions', name: 'Cloud Functions', category: 'hosting', implies: ['gcp'], matchers: [host('\\.cloudfunctions\\.net$'), h('function-execution-id', undefined, 0.9)] },
  { id: 'gcs', name: 'Google Cloud Storage', category: 'cloud', implies: ['gcp'], matchers: [host('^storage\\.googleapis\\.com$'), h('x-goog-generation', undefined, 0.9), h('x-guploader-uploadid', undefined, 0.8), { in: 'path', match: '[?&]X-Goog-Signature=', weight: 0.9 }] },
  { id: 'firebase', name: 'Firebase', category: 'cloud', implies: ['gcp'], matchers: [host('\\.firebaseapp\\.com$', 0.9), host('\\.web\\.app$', 0.6), host('\\.firebaseio\\.com$'), host('^firestore\\.googleapis\\.com$'), host('^firebasestorage\\.googleapis\\.com$')] },
  { id: 'firebase-auth', name: 'Firebase Authentication', category: 'auth', implies: ['firebase'], matchers: [host('^(identitytoolkit|securetoken)\\.googleapis\\.com$')] },

  // ---------- Azure ----------
  {
    id: 'azure',
    name: 'Microsoft Azure',
    category: 'cloud',
    matchers: [h('x-ms-request-id', undefined, 0.6), h('x-azure-ref', undefined, 0.9), c('ARRAffinity*', 0.9), host('\\.azurewebsites\\.net$'), host('\\.azurefd\\.net$'), host('\\.cloudapp\\.azure\\.com$')],
    infraCookies: [{ name: 'ARRAffinity*', reason: 'Azure App Service instance affinity' }],
  },
  { id: 'azure-storage', name: 'Azure Storage', category: 'cloud', implies: ['azure'], matchers: [host('\\.(blob|queue|table|file|dfs)\\.core\\.windows\\.net$'), server('Windows-Azure-(Blob|Queue|Table|File)', 0.95)] },
  { id: 'azure-apim', name: 'Azure API Management', category: 'cloud', implies: ['azure'], matchers: [host('\\.azure-api\\.net$'), rh('ocp-apim-subscription-key', undefined, 0.95), h('ocp-apim-*', undefined, 0.9)] },
  { id: 'azure-functions', name: 'Azure Functions', category: 'hosting', implies: ['azure'], matchers: [rh('x-functions-key', undefined, 0.9), path('^/api/[^/]+', 0.1)] },
  { id: 'entra-id', name: 'Microsoft Entra ID', category: 'auth', matchers: [host('^login\\.(microsoftonline\\.com|microsoft\\.com|windows\\.net)$'), host('\\.b2clogin\\.com$'), host('\\.ciamlogin\\.com$')] },

  // ---------- Other hosting ----------
  { id: 'vercel', name: 'Vercel', category: 'hosting', matchers: [server('^Vercel$'), h('x-vercel-id', undefined, 0.95), h('x-vercel-cache', undefined, 0.9), host('\\.vercel\\.app$', 0.9)] },
  { id: 'netlify', name: 'Netlify', category: 'hosting', matchers: [server('^Netlify$'), h('x-nf-request-id', undefined, 0.95), host('\\.netlify\\.app$', 0.9)] },
  { id: 'heroku', name: 'Heroku', category: 'hosting', matchers: [h('via', 'vegur', 0.85), host('\\.herokuapp\\.com$', 0.9), server('^heroku', 0.9)] },
  { id: 'github-pages', name: 'GitHub Pages', category: 'hosting', matchers: [host('\\.github\\.io$', 0.9), server('^GitHub\\.com$', 0.8)] },
  { id: 'fly', name: 'Fly.io', category: 'hosting', matchers: [server('^Fly/', 0.95), h('fly-request-id', undefined, 0.95), host('\\.fly\\.dev$', 0.9)] },

  // ---------- Web servers and proxies ----------
  { id: 'nginx', name: 'nginx', category: 'server', matchers: [server('^nginx')] },
  { id: 'openresty', name: 'OpenResty', category: 'server', implies: ['nginx'], matchers: [server('^openresty')] },
  { id: 'apache', name: 'Apache HTTP Server', category: 'server', matchers: [server('^Apache(?!-Coyote)')] },
  { id: 'iis', name: 'Microsoft IIS', category: 'server', matchers: [server('^Microsoft-IIS')], checks: [{ text: 'IIS sometimes exposes trace.axd and elmah.axd on development servers.', probe: { method: 'GET', path: '/trace.axd' } }] },
  { id: 'caddy', name: 'Caddy', category: 'server', matchers: [server('^Caddy')] },
  { id: 'envoy', name: 'Envoy', category: 'server', matchers: [server('^envoy'), h('x-envoy-upstream-service-time', undefined, 0.9)] },
  { id: 'litespeed', name: 'LiteSpeed', category: 'server', matchers: [server('^LiteSpeed')] },
  { id: 'tomcat', name: 'Apache Tomcat', category: 'server', implies: ['java'], matchers: [server('^Apache-Coyote', 0.9), body('<h3>Apache Tomcat/', 0.9)] },
  { id: 'jetty', name: 'Jetty', category: 'server', implies: ['java'], matchers: [server('^Jetty')] },
  { id: 'gunicorn', name: 'Gunicorn', category: 'server', implies: ['python'], matchers: [server('^gunicorn')] },
  { id: 'uvicorn', name: 'Uvicorn', category: 'server', implies: ['python'], matchers: [server('^uvicorn')] },
  { id: 'kestrel', name: 'Kestrel', category: 'server', implies: ['aspnet-core'], matchers: [server('^Kestrel')] },

  // ---------- Languages and runtimes ----------
  { id: 'php', name: 'PHP', category: 'language', matchers: [poweredBy('^PHP'), c('PHPSESSID', 0.95)] },
  { id: 'java', name: 'Java', category: 'language', matchers: [c('JSESSIONID', 0.9)] },
  { id: 'python', name: 'Python', category: 'language', matchers: [server('Python/', 0.9)] },
  { id: 'nodejs', name: 'Node.js', category: 'language', matchers: [] },
  { id: 'ruby', name: 'Ruby', category: 'language', matchers: [server('^(Puma|WEBrick|Passenger|thin)', 0.8)] },
  { id: 'dotnet', name: '.NET', category: 'language', matchers: [] },

  // ---------- Server frameworks ----------
  {
    id: 'rails',
    name: 'Ruby on Rails',
    category: 'framework',
    implies: ['ruby'],
    matchers: [body('<meta[^>]+name=["\']csrf-param["\'][^>]+content=["\']authenticity_token', 0.95), h('x-runtime', '^\\d+\\.\\d+$', 0.6), c('_*_session', 0.5), path('^/rails/active_storage/', 0.95)],
    csrf: [
      { source: { from: 'meta', name: 'csrf-token' }, sinks: [{ in: 'header', name: 'X-CSRF-Token' }] },
      { source: { from: 'input', name: 'authenticity_token' }, sinks: [{ in: 'form', name: 'authenticity_token' }] },
    ],
    checks: [{ text: 'Development builds list every route at /rails/info/routes.', probe: { method: 'GET', path: '/rails/info/routes' } }],
  },
  {
    id: 'django',
    name: 'Django',
    category: 'framework',
    implies: ['python'],
    matchers: [c('csrftoken', 0.9), c('sessionid', 0.3), body('name=["\']csrfmiddlewaretoken["\']', 0.95), body('You\'re seeing this error because you have <code>DEBUG = True</code>', 0.95)],
    csrf: [
      { source: { from: 'cookie', name: 'csrftoken' }, sinks: [{ in: 'header', name: 'X-CSRFToken' }] },
      { source: { from: 'input', name: 'csrfmiddlewaretoken' }, sinks: [{ in: 'form', name: 'csrfmiddlewaretoken' }] },
    ],
    checks: [
      { text: 'The admin site is usually at /admin/.', probe: { method: 'GET', path: '/admin/' } },
      { text: 'DEBUG = True pages show settings and the URL list on any 404.' },
    ],
  },
  {
    id: 'flask',
    name: 'Flask',
    category: 'framework',
    implies: ['python'],
    matchers: [server('^Werkzeug', 0.9), c('session', 0.4, '^\\.?eyJ[\\w-]*\\.[\\w-]+\\.[\\w-]+$')],
  },
  {
    id: 'laravel',
    name: 'Laravel',
    category: 'framework',
    implies: ['php'],
    matchers: [c('laravel_session', 0.95), c('XSRF-TOKEN', 0.3), c('*_session', 0.2)],
    csrf: [
      { source: { from: 'meta', name: 'csrf-token' }, sinks: [{ in: 'header', name: 'X-CSRF-TOKEN' }] },
      { source: { from: 'cookie', name: 'XSRF-TOKEN', urlDecode: true }, sinks: [{ in: 'header', name: 'X-XSRF-TOKEN' }] },
      { source: { from: 'input', name: '_token' }, sinks: [{ in: 'form', name: '_token' }] },
    ],
    checks: [
      { text: 'Telescope and Horizon dashboards are sometimes left open.', probe: { method: 'GET', path: '/telescope' } },
      { text: 'Ignition (debug mode) answers at /_ignition/health-check.', probe: { method: 'GET', path: '/_ignition/health-check' } },
    ],
  },
  { id: 'symfony', name: 'Symfony', category: 'framework', implies: ['php'], matchers: [h('x-debug-token', undefined, 0.9), h('x-debug-token-link', undefined, 0.95), c('sf_redirect', 0.9)], checks: [{ text: 'X-Debug-Token means the web profiler is on.', probe: { method: 'GET', path: '/_profiler' } }] },
  {
    id: 'spring',
    name: 'Spring',
    category: 'framework',
    implies: ['java'],
    matchers: [body('<h1>Whitelabel Error Page</h1>', 0.95), h('x-application-context', undefined, 0.85), body('<meta[^>]+name=["\']_csrf["\']', 0.9), { in: 'body', match: '"timestamp":"[^"]+","status":\\d{3},"error":"[^"]+","(message|path)"', weight: 0.7 }],
    csrf: [
      { source: { from: 'meta', name: '_csrf' }, sinks: [{ in: 'header', name: 'X-CSRF-TOKEN' }] },
      { source: { from: 'input', name: '_csrf' }, sinks: [{ in: 'form', name: '_csrf' }] },
      { source: { from: 'cookie', name: 'XSRF-TOKEN' }, sinks: [{ in: 'header', name: 'X-XSRF-TOKEN' }] },
    ],
    checks: [{ text: 'Spring Boot Actuator lists health, env and mappings endpoints when exposed.', probe: { method: 'GET', path: '/actuator' } }],
  },
  {
    id: 'aspnet',
    name: 'ASP.NET',
    category: 'framework',
    implies: ['dotnet'],
    matchers: [h('x-aspnet-version', undefined, 0.95), h('x-aspnetmvc-version', undefined, 0.95), poweredBy('^ASP\\.NET', 0.9), c('ASP.NET_SessionId', 0.95), c('.ASPXAUTH', 0.95), body('name=["\']__VIEWSTATE["\']', 0.95)],
    csrf: [{ source: { from: 'input', name: '__RequestVerificationToken' }, sinks: [{ in: 'form', name: '__RequestVerificationToken' }, { in: 'header', name: 'RequestVerificationToken' }] }],
    checks: [{ text: 'WebForms pages carry __VIEWSTATE; a replay of a postback needs the ViewState from the page it came from.' }],
  },
  {
    id: 'aspnet-core',
    name: 'ASP.NET Core',
    category: 'framework',
    implies: ['dotnet'],
    matchers: [c('.AspNetCore.*', 0.95)],
    csrf: [
      { source: { from: 'input', name: '__RequestVerificationToken' }, sinks: [{ in: 'form', name: '__RequestVerificationToken' }, { in: 'header', name: 'RequestVerificationToken' }] },
      { source: { from: 'cookie', name: 'XSRF-TOKEN' }, sinks: [{ in: 'header', name: 'X-XSRF-TOKEN' }] },
    ],
  },
  {
    id: 'express',
    name: 'Express',
    category: 'framework',
    implies: ['nodejs'],
    matchers: [poweredBy('^Express$'), c('connect.sid', 0.85)],
    csrf: [
      { source: { from: 'input', name: '_csrf' }, sinks: [{ in: 'form', name: '_csrf' }, { in: 'header', name: 'CSRF-Token' }, { in: 'header', name: 'X-CSRF-Token' }] },
      { source: { from: 'meta', name: 'csrf-token' }, sinks: [{ in: 'header', name: 'CSRF-Token' }, { in: 'header', name: 'X-CSRF-Token' }] },
    ],
  },

  // ---------- Front-end frameworks ----------
  {
    id: 'nextjs',
    name: 'Next.js',
    category: 'frontend',
    implies: ['react', 'nodejs'],
    matchers: [poweredBy('^Next\\.js'), body('<script id="__NEXT_DATA__"', 0.95), path('^/_next/', 0.9), h('x-nextjs-*', undefined, 0.95), rh('next-action', undefined, 0.95), rh('rsc', '^1$', 0.8), h('content-type', '^text/x-component', 0.9)],
  },
  { id: 'nuxt', name: 'Nuxt', category: 'frontend', implies: ['vue', 'nodejs'], matchers: [body('window\\.__NUXT__|id="__NUXT_DATA__"', 0.95), path('^/_nuxt/', 0.9), path('/_payload\\.json', 0.8)] },
  { id: 'sveltekit', name: 'SvelteKit', category: 'frontend', implies: ['svelte'], matchers: [body('data-sveltekit-', 0.9), path('^/_app/immutable/', 0.85), path('/__data\\.json$', 0.85)] },
  { id: 'remix', name: 'Remix', category: 'frontend', implies: ['react'], matchers: [body('window\\.__remixContext', 0.95), path('[?&]_data=', 0.6)] },
  {
    id: 'angular',
    name: 'Angular',
    category: 'frontend',
    matchers: [body('ng-version="', 0.95), body('<app-root', 0.5)],
    csrf: [{ source: { from: 'cookie', name: 'XSRF-TOKEN' }, sinks: [{ in: 'header', name: 'X-XSRF-TOKEN' }] }],
  },
  { id: 'react', name: 'React', category: 'frontend', matchers: [body('data-reactroot', 0.7)] },
  { id: 'vue', name: 'Vue.js', category: 'frontend', matchers: [body('data-server-rendered="true"', 0.7), body('<div id="app" data-v-', 0.6)] },
  { id: 'svelte', name: 'Svelte', category: 'frontend', matchers: [] },

  // ---------- CMS ----------
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'cms',
    implies: ['php'],
    matchers: [path('^/wp-(content|includes|admin|json)/', 0.9), h('link', 'rel="https://api\\.w\\.org/"', 0.95), body('/wp-content/', 0.8), c('wordpress_*', 0.9)],
    csrf: [{ source: { from: 'regex', name: '"nonce":"([0-9a-f]{10})"' }, sinks: [{ in: 'header', name: 'X-WP-Nonce' }, { in: 'form', name: '_wpnonce' }] }],
    checks: [{ text: 'The REST API lists users at /wp-json/wp/v2/users unless restricted.', probe: { method: 'GET', path: '/wp-json/wp/v2/users' } }],
  },
  { id: 'drupal', name: 'Drupal', category: 'cms', implies: ['php'], matchers: [h('x-generator', '^Drupal', 0.95), h('x-drupal-cache', undefined, 0.95), h('x-drupal-dynamic-cache', undefined, 0.95)] },

  // ---------- Auth ----------
  { id: 'jwt', name: 'JWT bearer tokens', category: 'auth', matchers: [rh('authorization', '^Bearer\\s+eyJ[\\w-]*\\.[\\w-]*\\.[\\w-]*$', 0.95)] },
  { id: 'oauth2', name: 'OAuth 2.0', category: 'auth', matchers: [{ in: 'requestBody', match: '(^|&)grant_type=', weight: 0.9 }, path('/(oauth2?/)?authorize\\?.*response_type=', 0.9), path('/oauth2?/token\\b', 0.7)] },
  { id: 'oidc', name: 'OpenID Connect', category: 'auth', implies: ['oauth2'], matchers: [path('^/(.*/)?\\.well-known/openid-configuration', 0.95), path('[?&]scope=[^&]*openid', 0.9)] },
  { id: 'auth0', name: 'Auth0', category: 'auth', implies: ['oidc'], matchers: [host('\\.auth0\\.com$'), c('auth0*', 0.6)] },
  { id: 'okta', name: 'Okta', category: 'auth', implies: ['oidc'], matchers: [host('\\.(okta|oktapreview|okta-emea)\\.com$')] },
  { id: 'keycloak', name: 'Keycloak', category: 'auth', implies: ['oidc'], matchers: [path('^/(auth/)?realms/[^/]+/protocol/openid-connect/', 0.95), c('KEYCLOAK_*', 0.9), c('AUTH_SESSION_ID*', 0.7)] },

  // ---------- Protocols carried over HTTP ----------
  { id: 'grpc', name: 'gRPC', category: 'protocol', matchers: [h('content-type', '^application/grpc(\\+|;|$)', 0.95), rh('content-type', '^application/grpc(\\+|;|$)', 0.95)] },
  { id: 'grpc-web', name: 'gRPC-Web', category: 'protocol', matchers: [rh('content-type', '^application/grpc-web', 0.95), rh('x-grpc-web', undefined, 0.95)] },
  { id: 'connect-rpc', name: 'Connect RPC', category: 'protocol', matchers: [rh('connect-protocol-version', undefined, 0.95)] },
  { id: 'socketio', name: 'Socket.IO', category: 'protocol', matchers: [path('/socket\\.io/\\?.*EIO=', 0.95)] },
  { id: 'signalr', name: 'SignalR', category: 'protocol', implies: ['dotnet'], matchers: [path('/negotiate\\?(.*&)?negotiateVersion=', 0.95), path('/signalr/(negotiate|connect)', 0.9), rh('x-signalr-user-agent', undefined, 0.95)] },
  { id: 'phoenix', name: 'Phoenix Channels', category: 'protocol', matchers: [path('/socket/websocket\\?(.*&)?vsn=', 0.9), path('/live/websocket\\?', 0.9)] },
  { id: 'actioncable', name: 'Action Cable', category: 'protocol', implies: ['rails'], matchers: [rh('sec-websocket-protocol', 'actioncable-', 0.95)] },
  { id: 'sse', name: 'Server-Sent Events', category: 'protocol', matchers: [h('content-type', '^text/event-stream', 0.95)] },
];

const VENDORS: Array<[RegExp, string]> = [
  [/^aws(-|$)/, 'Amazon Web Services'],
  [/^(gcp|gcs)(-|$)|^firebase/, 'Google Cloud'],
  [/^azure(-|$)|^entra-id$/, 'Microsoft Azure'],
  [/^cloudflare(-|$)/, 'Cloudflare'],
];

export const SIGNATURES: Signature[] = LIST.map((s) => {
  const v = VENDORS.find(([re]) => re.test(s.id))?.[1];
  return v ? { ...s, vendor: v } : s;
});

/** Generic names that usually carry a CSRF token, for frameworks with no signature. */
export const GENERIC_CSRF_NAME = /(^|[-_])(csrf|xsrf)([-_]|$)|csrf|xsrf|anti-?forgery|verification-?token|authenticity[-_]?token|^_token$|nonce/i;
