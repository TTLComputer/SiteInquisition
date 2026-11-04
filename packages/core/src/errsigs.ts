/**
 * Server error signatures: database errors, stack traces, framework debug
 * pages and parser errors that leak into responses. An error that echoes
 * part of the request is the most useful kind, so patterns capture what they
 * can as named groups:
 *
 *   near   the fragment of input the error quotes (MySQL "near '...'")
 *   param  a field or attribute name the error names
 *   type   the type the server expected
 *   pos    a character position in the request body
 *   file, line   where in the server's code it failed
 *
 * Like technology signatures these only read captured traffic.
 */

export type ErrorKind =
  | 'sql'
  | 'nosql'
  | 'template'
  | 'xml'
  | 'command'
  | 'deserialization'
  | 'ldap'
  | 'file'
  | 'parse'
  | 'type'
  | 'stack-trace'
  | 'debug-page';

export type ErrorSeverity = 'high' | 'medium' | 'low';

export interface ErrorSignature {
  id: string;
  name: string;
  kind: ErrorKind;
  severity: ErrorSeverity;
  /** Regex over the response body. Named groups: near, param, type, pos, file, line. */
  pattern: string;
  /** Regex flags, default "i". */
  flags?: string;
  /** A technology this implies, by technology signature id. */
  tech?: string;
  /** What it usually means and what to try next. */
  hint: string;
}

/** Kinds that often mean user input reached an interpreter. */
export const INJECTION_KINDS: ErrorKind[] = ['sql', 'nosql', 'template', 'xml', 'command', 'deserialization', 'ldap', 'file'];

const SQL_HINT = 'A database rejected a query built from this request. Input that breaks SQL syntax often means the query is built by string concatenation (SQL injection).';

export const ERROR_SIGNATURES: ErrorSignature[] = [
  // ---------- SQL ----------
  { id: 'mysql-syntax', name: 'MySQL syntax error', kind: 'sql', severity: 'high', tech: 'mysql', pattern: "You have an error in your SQL syntax; check the manual that corresponds to your (?:MySQL|MariaDB) server version for the right syntax to use near '(?<near>[\\s\\S]{0,500}?)' at line \\d+", hint: SQL_HINT },
  { id: 'mysql-error', name: 'MySQL error', kind: 'sql', severity: 'high', tech: 'mysql', pattern: "(?:Warning: mysqli?_\\w+\\(\\)|mysqli_sql_exception|com\\.mysql\\.(?:cj\\.)?jdbc|MySqlException|MySQLSyntaxErrorException|ER_PARSE_ERROR|ER_BAD_FIELD_ERROR: Unknown column '(?<param>[^']+)'|Unknown column '(?<param2>[^']+)' in '(?:field list|where clause|order clause)')", hint: SQL_HINT },
  { id: 'postgres-syntax', name: 'PostgreSQL syntax error', kind: 'sql', severity: 'high', tech: 'postgres', pattern: '(?:ERROR|PSQLException|PG::SyntaxError|psycopg2?\\.errors?\\.\\w+)?[: ]*(?:syntax error at or near|unterminated quoted (?:string|identifier) at or near) "(?<near>[^"]*)"', hint: SQL_HINT },
  { id: 'postgres-input', name: 'PostgreSQL invalid input', kind: 'sql', severity: 'medium', tech: 'postgres', pattern: 'invalid input syntax for (?:type )?(?<type>[\\w ]+): "(?<near>[^"]*)"', hint: 'PostgreSQL got a value of the wrong type. Not injection by itself, but it shows the value reaches a query unchecked.' },
  { id: 'postgres-error', name: 'PostgreSQL error', kind: 'sql', severity: 'high', tech: 'postgres', pattern: '(?:pg_query\\(\\)|pg_exec\\(\\)|org\\.postgresql\\.util\\.PSQLException|PG::(?:\\w+Error)|Npgsql\\.PostgresException|column "(?<param>[^"]+)" does not exist)', hint: SQL_HINT },
  { id: 'mssql-quote', name: 'SQL Server unclosed quotation', kind: 'sql', severity: 'high', tech: 'mssql', pattern: "Unclosed quotation mark after the character string '(?<near>[^\\n]{0,500}?)'\\.?(?=\\s|$|<|\")", hint: SQL_HINT },
  { id: 'mssql-syntax', name: 'SQL Server syntax error', kind: 'sql', severity: 'high', tech: 'mssql', pattern: "Incorrect syntax near '(?<near>[^\\n]{0,200}?)'\\.?(?=\\s|$|<|\")", hint: SQL_HINT },
  { id: 'mssql-error', name: 'SQL Server error', kind: 'sql', severity: 'high', tech: 'mssql', pattern: "(?:System\\.Data\\.SqlClient\\.SqlException|Microsoft\\.Data\\.SqlClient\\.SqlException|Microsoft OLE DB Provider for SQL Server|\\[SQL Server\\]|Conversion failed when converting the (?:n?varchar) value '(?<near>[^']*)' to data type (?<type>\\w+)|Invalid column name '(?<param>[^']+)')", hint: SQL_HINT },
  { id: 'oracle-error', name: 'Oracle database error', kind: 'sql', severity: 'high', tech: 'oracle', pattern: '\\bORA-(?:00933|00936|01756|00907|00904|01722|00911|01789|01476)\\b(?:[^\\n]*?"(?<param>[A-Z0-9_$#]+)": invalid identifier)?', flags: '', hint: SQL_HINT },
  { id: 'sqlite-error', name: 'SQLite error', kind: 'sql', severity: 'high', tech: 'sqlite', pattern: '(?:near "(?<near>[^"]*)": syntax error|SQLITE_ERROR|sqlite3\\.OperationalError|SQLiteException|unrecognized token: "(?<near2>[^"]*)"|no such column: (?<param>[\\w.]+))', hint: SQL_HINT },
  { id: 'sqlstate', name: 'SQLSTATE error', kind: 'sql', severity: 'high', pattern: 'SQLSTATE\\[(?:42\\w{3}|22\\w{3}|HY000|21000|23000)\\]', flags: '', hint: SQL_HINT },
  { id: 'orm-error', name: 'ORM database error', kind: 'sql', severity: 'high', pattern: '(?:SequelizeDatabaseError|PrismaClientKnownRequestError|QueryFailedError|Doctrine\\\\DBAL\\\\(?:Exception|Driver)|ActiveRecord::StatementInvalid|django\\.db\\.utils\\.(?:ProgrammingError|OperationalError|DataError)|sqlalchemy\\.exc\\.(?:ProgrammingError|OperationalError|DataError)|org\\.hibernate\\.(?:exception\\.SQLGrammarException|QueryException)|PDOException|Illuminate\\\\Database\\\\QueryException|java\\.sql\\.SQLSyntaxErrorException)', flags: '', hint: SQL_HINT },
  { id: 'sql-integrity', name: 'Database constraint violation', kind: 'sql', severity: 'low', pattern: "(?:Duplicate entry '(?<near>[^']*)' for key|duplicate key value violates unique constraint|UNIQUE constraint failed: (?<param>[\\w.]+)|violates foreign key constraint|Cannot add or update a child row)", hint: 'A constraint rejected the write. Useful for finding which values already exist.' },

  // ---------- NoSQL ----------
  { id: 'mongo-error', name: 'MongoDB error', kind: 'nosql', severity: 'high', tech: 'mongodb', pattern: '(?:MongoServerError|MongoError|MongoDB\\.Driver\\.\\w+Exception|unknown operator: (?<near>\\$\\w+)|\\$where is not allowed|BSONTypeError)', flags: '', hint: 'MongoDB rejected a query built from this request. Operators such as $ne or $where in input can mean NoSQL injection.' },
  { id: 'mongoose-cast', name: 'Mongoose cast error', kind: 'nosql', severity: 'medium', tech: 'mongodb', pattern: 'Cast to (?<type>\\w+) failed for value "(?<near>[^"]*)"(?: \\(type \\w+\\))? at path "(?<param>[^"]+)"', hint: 'A value did not fit the schema type. Objects in place of strings are worth trying here.' },

  // ---------- Templates ----------
  { id: 'template-error', name: 'Template engine error', kind: 'template', severity: 'high', pattern: '(?:jinja2\\.exceptions\\.\\w+|TemplateSyntaxError|Twig\\\\Error\\\\(?:Syntax|Runtime)Error|FreeMarker template error|freemarker\\.core\\.\\w+Exception|org\\.thymeleaf\\.exceptions|org\\.apache\\.velocity\\.exception|Liquid::SyntaxError|ActionView::Template::Error|Handlebars: .*Parse error|ERB::\\w*Error|Smarty error|Mako\\w*Exception)', flags: '', hint: 'A template failed to render. When input reaches a template (for example {{7*7}}), this can be server-side template injection.' },

  // ---------- XML ----------
  { id: 'xml-error', name: 'XML parser error', kind: 'xml', severity: 'high', pattern: '(?:org\\.xml\\.sax\\.SAXParseException|lxml\\.etree\\.XMLSyntaxError|xml\\.etree\\.ElementTree\\.ParseError|XML ?Parsing Error|simplexml_load_string\\(\\)|DOMDocument::loadXML\\(\\)|System\\.Xml\\.XmlException|XmlPullParserException|DOCTYPE is disallowed|External entit(?:y|ies)|undefined entity)', hint: 'The server parsed XML from this request. Parsers that accept a DOCTYPE may allow XXE.' },

  // ---------- Command, file, LDAP, deserialization ----------
  { id: 'command-error', name: 'Shell command error', kind: 'command', severity: 'high', pattern: "(?:sh: \\d+: (?<near>[^:\\n]+): not found|/bin/(?:ba)?sh: (?:line \\d+: )?(?<near2>[^:\\n]+): command not found|'(?<near3>[^']+)' is not recognized as an internal or external command|java\\.io\\.IOException: Cannot run program \"(?<near4>[^\"]+)\"|child_process|ProcessBuilder)", hint: 'A shell ran something built from this request. Metacharacters such as ; | $( ) in input can mean command injection.' },
  { id: 'file-error', name: 'File access error', kind: 'file', severity: 'medium', pattern: "(?:failed to open stream: No such file or directory|ENOENT: no such file or directory, (?:open|stat|scandir) '(?<near>[^']+)'|java\\.io\\.FileNotFoundException:? (?<near2>\\S+)?|include(?:_once)?\\(\\): Failed opening '(?<near3>[^']+)'|open_basedir restriction in effect|No such file or directory @ rb_sysopen - (?<near4>\\S+)|FileNotFoundError: \\[Errno 2\\] No such file or directory: '(?<near5>[^']+)')", hint: 'The server tried to open a path built from this request. ../ sequences in input can mean path traversal or file inclusion.' },
  { id: 'ldap-error', name: 'LDAP error', kind: 'ldap', severity: 'high', pattern: '(?:javax\\.naming\\.(?:directory\\.)?\\w*Exception|LDAPException|Bad search filter|ldap_search\\(\\)|System\\.DirectoryServices\\.\\w*Exception|Protocol error occurred)', hint: 'An LDAP query failed. Characters such as * ( ) & | in input can mean LDAP injection.' },
  { id: 'deserialization-error', name: 'Deserialization error', kind: 'deserialization', severity: 'high', pattern: '(?:java\\.io\\.(?:InvalidClassException|StreamCorruptedException|OptionalDataException)|unserialize\\(\\): Error at offset (?<pos>\\d+)|_pickle\\.UnpicklingError|System\\.Runtime\\.Serialization\\.SerializationException|BinaryFormatter|ObjectInputStream|Marshal\\.load|YAML::\\w*Error|com\\.fasterxml\\.jackson\\.databind\\.exc\\.InvalidTypeIdException)', flags: '', hint: 'The server deserialized data from this request. Native serialization formats (Java, PHP, pickle, .NET) can lead to code execution.' },

  // ---------- Parsing and types ----------
  { id: 'json-parse', name: 'JSON parse error', kind: 'parse', severity: 'low', pattern: '(?:Unexpected token (?<near>.) in JSON at position (?<pos>\\d+)|Unexpected (?:token|end of JSON input)|JSON\\.parse: [^\\n]+ at line \\d+ column (?<pos2>\\d+)|com\\.fasterxml\\.jackson\\.core\\.JsonParseException|JsonReaderException|json\\.decoder\\.JSONDecodeError: [^\\n]*\\(char (?<pos3>\\d+)\\)|Malformed JSON)', hint: 'The request body was not valid JSON. Expected after an edit; otherwise the body was mangled.' },
  { id: 'jackson-type', name: 'Jackson type mismatch', kind: 'type', severity: 'low', tech: 'java', pattern: 'Cannot deserialize value of type `(?<type>[^`]+)` from (?:String|Number|Object|Array) (?:"(?<near>[^"]*)")?', flags: '', hint: 'A JSON field had the wrong type for the Java class it maps to.' },
  { id: 'python-type', name: 'Python exception', kind: 'type', severity: 'medium', tech: 'python', pattern: "(?:KeyError: '(?<param>[^']+)'|AttributeError: '\\w+' object has no attribute '(?<param2>\\w+)'|ValueError: invalid literal for int\\(\\) with base 10: '(?<near>[^']*)'|TypeError: [^\\n]{0,120})", flags: '', hint: 'Unhandled Python exception. Missing or odd fields are usually the cause.' },
  { id: 'js-type', name: 'JavaScript exception', kind: 'type', severity: 'medium', tech: 'nodejs', pattern: "(?:TypeError: Cannot read propert(?:y|ies) of (?:undefined|null)(?: \\(reading '(?<param>[^']+)'\\))?|TypeError: [\\w.$]+ is not a function|ReferenceError: \\w+ is not defined)", flags: '', hint: 'Unhandled JavaScript exception. A missing or wrongly typed field is the usual cause.' },
  { id: 'null-reference', name: 'Null reference', kind: 'type', severity: 'medium', pattern: "(?:java\\.lang\\.NullPointerException|System\\.NullReferenceException|undefined method `(?<param>\\w+)' for nil|NoMethodError)", flags: '', hint: 'Unhandled null reference. A missing field or an id that does not exist is the usual cause.' },
  { id: 'number-format', name: 'Number format error', kind: 'type', severity: 'low', pattern: '(?:java\\.lang\\.NumberFormatException: For input string: "(?<near>[^"]*)"|System\\.FormatException|Input string was not in a correct format)', flags: '', hint: 'A field expected a number.' },

  // ---------- Stack traces ----------
  { id: 'python-trace', name: 'Python traceback', kind: 'stack-trace', severity: 'medium', tech: 'python', pattern: 'Traceback \\(most recent call last\\):[\\s\\S]{0,4000}?File "(?<file>[^"]+)", line (?<line>\\d+)', flags: '', hint: 'A stack trace leaks file paths and code structure.' },
  { id: 'java-trace', name: 'Java stack trace', kind: 'stack-trace', severity: 'medium', tech: 'java', pattern: '(?:[\\w$.]+(?:Exception|Error))(?::[^\\n]*)?\\s*(?:\\n|<br\\s*/?>|\\\\n)\\s*at [\\w$.<>]+\\((?<file>[\\w$]+\\.(?:java|kt|scala)):(?<line>\\d+)\\)', flags: '', hint: 'A stack trace leaks class names, libraries and versions.' },
  { id: 'dotnet-trace', name: '.NET stack trace', kind: 'stack-trace', severity: 'medium', tech: 'dotnet', pattern: '(?:System\\.\\w+(?:\\.\\w+)*Exception|[\\w.]+Exception):[^\\n]*(?:\\n|<br\\s*/?>|\\\\r?\\\\n)\\s*at [\\w.`<>[\\],]+\\([^)]*\\)(?: in (?<file>[^:\\n]+(?::[^:\\n]+)?):line (?<line>\\d+))?', flags: '', hint: 'A stack trace leaks namespaces and, with debug symbols, source paths.' },
  { id: 'node-trace', name: 'Node.js stack trace', kind: 'stack-trace', severity: 'medium', tech: 'nodejs', pattern: '(?:Error|Exception)[^\\n]*(?:\\n|<br\\s*/?>|\\\\n)\\s*at (?:[\\w$.<>]+ )?\\(?(?<file>(?:/|[A-Z]:\\\\)[^:)\\n]+\\.(?:m?js|cjs|ts)):(?<line>\\d+):\\d+\\)?', flags: '', hint: 'A stack trace leaks file paths and module names.' },
  { id: 'php-error', name: 'PHP error', kind: 'stack-trace', severity: 'medium', tech: 'php', pattern: '(?:<b>)?(?:Fatal error|Parse error|Warning|Notice|Deprecated|Uncaught \\w+)(?:</b>)?:\\s[^\\n]{0,300}? in (?:<b>)?(?<file>[^<\\n]+?\\.php)(?:</b>)? on line (?:<b>)?(?<line>\\d+)', flags: '', hint: 'PHP shows errors to visitors (display_errors is on), leaking paths and code.' },
  { id: 'ruby-trace', name: 'Ruby backtrace', kind: 'stack-trace', severity: 'medium', tech: 'ruby', pattern: "(?<file>[\\w/.-]+\\.rb):(?<line>\\d+):in [`'][\\w<>! ?]+'", flags: '', hint: 'A backtrace leaks file paths and gem versions.' },
  { id: 'go-panic', name: 'Go panic', kind: 'stack-trace', severity: 'medium', pattern: 'panic: [^\\n]+\\s+goroutine \\d+ \\[running\\]:[\\s\\S]{0,800}?(?<file>/[^\\s:]+\\.go):(?<line>\\d+)', flags: '', hint: 'An unrecovered panic leaks paths and the call stack.' },

  // ---------- Framework debug pages ----------
  { id: 'django-debug', name: 'Django debug page', kind: 'debug-page', severity: 'high', tech: 'django', pattern: "You're seeing this error because you have <code>DEBUG = True</code>", flags: '', hint: 'DEBUG = True shows settings, the URL list and local variables to anyone.' },
  { id: 'werkzeug-debugger', name: 'Werkzeug debugger', kind: 'debug-page', severity: 'high', tech: 'flask', pattern: '(?:Werkzeug Debugger|The debugger caught an exception in your WSGI application)', flags: '', hint: 'The Werkzeug debugger can run code in the server when its PIN is known or disabled.' },
  { id: 'rails-debug', name: 'Rails exception page', kind: 'debug-page', severity: 'high', tech: 'rails', pattern: '(?:Action Controller: Exception caught|<h1>Routing Error</h1>|ActiveRecord::RecordNotFound in )', flags: '', hint: 'Rails is running with full error reports on, which shows code, routes and parameters.' },
  { id: 'laravel-debug', name: 'Laravel debug page', kind: 'debug-page', severity: 'high', tech: 'laravel', pattern: '(?:Whoops, looks like something went wrong|window\\.ignite|Illuminate\\\\[\\w\\\\]+Exception|"exception":\\s*"Illuminate)', flags: '', hint: 'APP_DEBUG is on, which can show environment variables and code.' },
  { id: 'symfony-debug', name: 'Symfony exception page', kind: 'debug-page', severity: 'high', tech: 'symfony', pattern: '(?:Symfony\\\\Component\\\\[\\w\\\\]+Exception|sf-toolbar|class="exception-message")', flags: '', hint: 'Symfony is in debug mode; the profiler may be reachable too.' },
  { id: 'aspnet-ysod', name: 'ASP.NET error page', kind: 'debug-page', severity: 'medium', tech: 'aspnet', pattern: "(?:Server Error in '[^']*' Application|An unhandled exception occurred while processing the request|<title>Runtime Error</title>|DeveloperExceptionPageMiddleware)", flags: '', hint: 'ASP.NET shows detailed errors (customErrors off or the developer exception page).' },
  { id: 'spring-error', name: 'Spring error response', kind: 'debug-page', severity: 'low', tech: 'spring', pattern: '(?:<h1>Whitelabel Error Page</h1>|"trace":\\s*"[\\w.$]+(?:Exception|Error))', flags: '', hint: 'Spring error details; a "trace" field leaks the stack.' },
  { id: 'express-error', name: 'Express error page', kind: 'debug-page', severity: 'medium', tech: 'express', pattern: '<pre>[^<]*Error[^<]*<br> &nbsp; &nbsp;at ', flags: '', hint: 'Express is in development mode and prints stack traces.' },
  { id: 'tomcat-error', name: 'Tomcat error report', kind: 'debug-page', severity: 'medium', tech: 'tomcat', pattern: '<h3>Apache Tomcat/[\\d.]+</h3>|<b>(?:Root Cause|Exception)</b>\\s*<pre>', flags: '', hint: 'Tomcat shows the exception and its version.' },
];
