import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ allErrors: true, strict: true, coerceTypes: false, removeAdditional: false });
addFormats(ajv);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const escape = (key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const pointer = (base, key) => `${base}/${escape(key)}`;
const validPointer = (path) => typeof path === 'string' && path.startsWith('/') &&
  path.slice(1).split('/').every((segment) => !/~(?![01])/u.test(segment));

class CannotConvert extends Error {
  constructor(code, message, path = '') {
    super(message);
    this.code = code;
    this.path = path;
  }
}

function dereference(root, path) {
  if (!path.startsWith('/')) throw new CannotConvert('invalid_alias', 'Alias paths must be JSON Pointers', path);
  let value = root;
  for (const segment of path.slice(1).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !own(value, key)) {
      throw new CannotConvert('missing_source', `Alias source ${path} is missing`, path);
    }
    value = value[key];
  }
  return value;
}

function fromExample(example) {
  if (example === null) return { type: 'null' };
  if (Array.isArray(example)) {
    if (!example.length) throw new CannotConvert('ambiguous_example', 'An empty array cannot specify an item type');
    return { type: 'array', items: fromExample(example[0]) };
  }
  if (typeof example === 'object') {
    if (!Object.keys(example).length) throw new CannotConvert('ambiguous_example', 'An empty object has no target fields');
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(example).map(([key, value]) => [key, fromExample(value)])),
      required: Object.keys(example),
      additionalProperties: true,
    };
  }
  return { type: Number.isInteger(example) ? 'integer' : typeof example };
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function acceptType(value, type) {
  return type === typeOf(value) || (type === 'number' && typeOf(value) === 'integer');
}

function convertScalar(value, type, path, source, trace) {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new CannotConvert('unsafe_integer', 'Integer exceeds JavaScript safe range; send it as a string', path);
  }
  if (acceptType(value, type)) return value;
  let result;
  if ((type === 'integer' || type === 'number') && typeof value === 'string') {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
      throw new CannotConvert('unsafe_coercion', `Not a canonical decimal number: ${value}`, path);
    }
    result = Number(value);
    if (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result))) {
      throw new CannotConvert('unsafe_coercion', 'Number is not safely representable', path);
    }
    if (String(result) !== value) {
      throw new CannotConvert('unsafe_coercion', 'Decimal text would change when converted to a JSON number', path);
    }
  } else if (type === 'boolean' && typeof value === 'string' && /^(true|false)$/.test(value)) {
    result = value === 'true';
  } else if (type === 'string' && typeof value === 'number' && Number.isFinite(value)) {
    result = String(value);
  } else {
    throw new CannotConvert('unsafe_coercion', `Cannot safely change ${typeOf(value)} to ${type}`, path);
  }
  if (!acceptType(result, type)) throw new CannotConvert('unsafe_coercion', `Converted value is not ${type}`, path);
  trace.push({ path, source, operation: 'coerce', from: typeOf(value), to: typeOf(result) });
  return result;
}

function walk(value, schema, path, source, context) {
  if (schema === false) throw new CannotConvert('unsupported_target', 'Target schema rejects all values', path);
  if (schema === true || !schema || typeof schema !== 'object') return value;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const selected = types.find((type) => acceptType(value, type)) ?? types.find((type) => type !== 'null');
  if (!selected) return value;

  if (selected === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new CannotConvert('unsafe_coercion', 'Expected an object', path);
    }
    const output = Object.create(null);
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(props)) {
      const dest = pointer(path, key);
      const aliased = context.aliases[dest];
      const nestedAlias = Object.keys(context.aliases).some((name) => name.startsWith(`${dest}/`));
      if (!own(value, key) && !aliased && !nestedAlias) {
        if ((schema.required ?? []).includes(key)) throw new CannotConvert('missing_required', `Missing required field ${dest}`, dest);
        continue;
      }
      if (aliased && own(value, key) && aliased !== pointer(source, key) &&
          JSON.stringify(value[key]) !== JSON.stringify(dereference(context.original, aliased))) {
        throw new CannotConvert('alias_conflict', `Alias ${dest} conflicts with an existing field; choose one source explicitly`, dest);
      }
      const raw = aliased ? dereference(context.original, aliased) : own(value, key) ? value[key] : {};
      const origin = aliased ?? (own(value, key) ? pointer(source, key) : '(constructed)');
      if (aliased) context.consumed.add(aliased);
      if (aliased) context.trace.push({ path: dest, source: origin, operation: 'alias' });
      if (nestedAlias && !own(value, key) && !aliased) context.trace.push({ path: dest, source: '(constructed)', operation: 'object' });
      output[key] = walk(raw, child, dest, origin, context);
      context.fields.push({ path: dest, source: origin });
    }
    for (const [key, raw] of Object.entries(value)) {
      if (own(output, key) || own(props, key) || context.consumed.has(pointer(source, key))) continue;
      const dest = pointer(path, key);
      if (schema.additionalProperties === false) {
        if (!context.allowDrop) throw new CannotConvert('extra_field', `Extra field ${dest}; dropping data requires allow_drop_extras`, dest);
        context.trace.push({ path: dest, source: pointer(source, key), operation: 'drop' });
      } else {
        output[key] = raw;
        context.fields.push({ path: dest, source: pointer(source, key) });
      }
    }
    return output;
  }
  if (selected === 'array') {
    if (!Array.isArray(value)) throw new CannotConvert('unsafe_coercion', 'Expected an array', path);
    return value.map((item, index) => {
      const dest = pointer(path, index);
      const origin = pointer(source, index);
      const converted = walk(item, schema.items, dest, origin, context);
      context.fields.push({ path: dest, source: origin });
      return converted;
    });
  }
  return convertScalar(value, selected, path, source, context.trace);
}

export function adapt(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 'error', code: 'invalid_request', message: 'Request must be a JSON object' };
  }
  const { mode = 'convert', direction = 'response', payload, target_schema, target_example, aliases = {}, allow_drop_extras = false } = request;
  if (!['convert', 'preflight'].includes(mode) || !['request', 'response'].includes(direction) || !own(request, 'payload')) {
    return { status: 'error', code: 'invalid_request', message: 'Provide mode, direction and payload' };
  }
  if ((target_schema === undefined) === (target_example === undefined)) {
    return { status: 'error', code: 'invalid_request', message: 'Provide exactly one of target_schema or target_example' };
  }
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.values(aliases).some((v) => typeof v !== 'string')) {
    return { status: 'error', code: 'invalid_request', message: 'aliases must map destination JSON Pointers to source JSON Pointers' };
  }
  if (Object.entries(aliases).some(([dest, source]) => !validPointer(dest) || !validPointer(source))) {
    return { status: 'error', code: 'invalid_request', message: 'Every alias destination and source must be a valid JSON Pointer beginning with /' };
  }
  if (typeof allow_drop_extras !== 'boolean') {
    return { status: 'error', code: 'invalid_request', message: 'allow_drop_extras must be a boolean' };
  }
  try {
    const inferred = target_schema === undefined;
    const schema = inferred ? fromExample(target_example) : target_schema;
    const validate = ajv.compile(schema);
    if (inferred && !validate(target_example)) {
      throw new CannotConvert('ambiguous_example', 'The target example has inconsistent value types or array items');
    }
    const context = { original: payload, aliases, allowDrop: allow_drop_extras === true, trace: [], fields: [], consumed: new Set() };
    const output = walk(payload, schema, '', '', context);
    const unusedAliases = Object.keys(aliases).filter((dest) => !context.trace.some((entry) => entry.path === dest && entry.operation === 'alias'));
    if (unusedAliases.length) {
      throw new CannotConvert('unused_alias', `Alias destination ${unusedAliases[0]} is not a target field`, unusedAliases[0]);
    }
    if (!validate(output)) {
      throw new CannotConvert('validation_failed', JSON.stringify(validate.errors), validate.errors?.[0]?.instancePath ?? '');
    }
    const common = {
      status: 'ok', mode, direction, convertible: true,
      target: inferred ? 'example_inferred_for_this_request' : 'provided_schema',
      changes: context.trace, validation: { passed: true, validator: 'ajv-draft-2020-12' },
    };
    if (mode === 'preflight') return common;
    return { ...common, output, provenance: context.fields };
  } catch (error) {
    return {
      status: 'unsupported', mode, direction, convertible: false,
      code: error.code ?? 'invalid_schema', path: error.path ?? '', message: error.message,
    };
  }
}
