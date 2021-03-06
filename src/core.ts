/*!
 * https://github.com/Starcounter-Jack/JSON-Patch
 * (c) 2017 Joachim Wester
 * MIT license
 */
declare var require: any;

const equalsOptions = { strict: true };
const _equals = require('deep-equal');
const areEquals = (a: any, b: any): boolean => {
  return _equals(a, b, equalsOptions)
}
import { PatchError, _deepClone, isInteger, unescapePathComponent, hasUndefined } from './helpers';

export const JsonPatchError = PatchError;
export const deepClone = _deepClone;

interface HTMLElement {
  attachEvent: Function;
  detachEvent: Function;
}

export type Operation = AddOperation<any> | RemoveOperation<any> | ReplaceOperation<any> | MoveOperation | CopyOperation | TestOperation<any> | GetOperation<any>;

export interface Validator<T> {
  (operation: Operation, index: number, document: T, existingPathFragment: string): void;
}

export interface OperationResult<T> {
  removed?: any,
  test?: boolean,
  newDocument: T;
}

export interface InvertableOperation<T> {
  oldValue?: T;
}

export interface BaseOperation {
  path: string;
}

export interface AddOperation<T> extends BaseOperation {
  op: 'add';
  value: T;
}

export interface RemoveOperation<T> extends BaseOperation, InvertableOperation<T> {
  op: 'remove';
}

export interface ReplaceOperation<T> extends BaseOperation, InvertableOperation<T> {
  op: 'replace';
  value: T;
}

export interface MoveOperation extends BaseOperation {
  op: 'move';
  from: string;
}

export interface CopyOperation extends BaseOperation {
  op: 'copy';
  from: string;
}

export interface TestOperation<T> extends BaseOperation {
  op: 'test';
  value: T;
}

export interface GetOperation<T> extends BaseOperation {
  op: '_get';
  value: T;
}
export interface PatchResult<T> extends Array<OperationResult<T>> {
  newDocument: T;
}

export interface Observer<T> {
  object: T;
  patches: Operation[];
  unobserve: () => void;
  callback: (patches: Operation[]) => void;
}

/* We use a Javascript hash to store each
 function. Each hash entry (property) uses
 the operation identifiers specified in rfc6902.
 In this way, we can map each patch operation
 to its dedicated function in efficient way.
 */

/* The operations applicable to an object */
const objOps = {
  add: function (obj, key, document) {
    obj[key] = this.value;
    return { newDocument: document };
  },
  remove: function (obj, key, document) {
    var removed = obj[key];
    delete obj[key];
    return { newDocument: document, removed }
  },
  replace: function (obj, key, document) {
    var removed = obj[key];
    obj[key] = this.value;
    return { newDocument: document, removed };
  },
  move: function (obj, key, document) {
    /* in case move target overwrites an existing value,
    return the removed value, this can be taxing performance-wise,
    and is potentially unneeded */
    let removed = getValueByPointer(document, this.path);

    if (removed) {
      removed = _deepClone(removed);
    }

    const originalValue = applyOperation(document,
      { op: "remove", path: this.from }
    ).removed;

    applyOperation(document,
      { op: "add", path: this.path, value: originalValue }
    );

    return { newDocument: document, removed };
  },
  copy: function (obj, key, document) {
    const valueToCopy = getValueByPointer(document, this.from);
    // enforce copy by value so further operations don't affect source (see issue #177)
    applyOperation(document,
      { op: "add", path: this.path, value: _deepClone(valueToCopy) }
    );
    return { newDocument: document }
  },
  test: function (obj, key, document) {
    return { newDocument: document, test: areEquals(obj[key], this.value) }
  },
  _get: function (obj, key, document) {
    this.value = obj[key];
    return { newDocument: document }
  }
};

/* The operations applicable to an array. Many are the same as for the object */
var arrOps = {
  add: function (arr, i, document) {
    if(isInteger(i)) {
      arr.splice(i, 0, this.value);
    } else { // array props
      arr[i] = this.value;
    }
    // this may be needed when using '-' in an array
    return { newDocument: document, index: i }
  },
  remove: function (arr, i, document) {
    var removedList = arr.splice(i, 1);
    return { newDocument: document, removed: removedList[0] };
  },
  replace: function (arr, i, document) {
    var removed = arr[i];
    arr[i] = this.value;
    return { newDocument: document, removed };
  },
  move: objOps.move,
  copy: objOps.copy,
  test: objOps.test,
  _get: objOps._get
};

/**
 * Retrieves a value from a JSON document by a JSON pointer.
 * Returns the value.
 *
 * @param document The document to get the value from
 * @param pointer an escaped JSON pointer
 * @return The retrieved value
 */
export function getValueByPointer(document: any, pointer: string): any {
  if (pointer == '') {
    return document;
  }
  var getOriginalDestination = <GetOperation<any>>{ op: "_get", path: pointer };
  applyOperation(document, getOriginalDestination);
  return getOriginalDestination.value;
}
/**
 * Apply a single JSON Patch Operation on a JSON document.
 * Returns the {newDocument, result} of the operation.
 * It modifies the `document` and `operation` objects - it gets the values by reference.
 * If you would like to avoid touching your values, clone them:
 * `jsonpatch.applyOperation(document, jsonpatch._deepClone(operation))`.
 *
 * @param document The document to patch
 * @param operation The operation to apply
 * @param validateOperation `false` is without validation, `true` to use default jsonpatch's validation, or you can pass a `validateOperation` callback to be used for validation.
 * @param mutateDocument Whether to mutate the original document or clone it before applying
 * @return `{newDocument, result}` after the operation
 */
export function applyOperation<T>(document: T, operation: Operation, validateOperation: boolean | Validator<T> = false, mutateDocument: boolean = true): OperationResult<T> {
  if (validateOperation) {
    if (typeof validateOperation == 'function') {
      validateOperation(operation, 0, document, operation.path);
    }
    else {
      validator(operation, 0);
    }
  }
  /* ROOT OPERATIONS */
  if (operation.path === "") {
    let returnValue: OperationResult<T> = { newDocument: document };
    if (operation.op === 'add') {
      returnValue.newDocument = operation.value;
      return returnValue;
    } else if (operation.op === 'replace') {
      returnValue.newDocument = operation.value;
      returnValue.removed = document; //document we removed
      return returnValue;
    }
    else if (operation.op === 'move' || operation.op === 'copy') { // it's a move or copy to root
      returnValue.newDocument = getValueByPointer(document, operation.from); // get the value by json-pointer in `from` field
      if (operation.op === 'move') { // report removed item
        returnValue.removed = document;
      }
      return returnValue;
    } else if (operation.op === 'test') {
      returnValue.test = areEquals(document, operation.value);
      if (returnValue.test === false) {
        throw new JsonPatchError("Test operation failed", 'TEST_OPERATION_FAILED', 0, operation, document);
      }
      returnValue.newDocument = document;
      return returnValue;
    } else if (operation.op === 'remove') { // a remove on root
      returnValue.removed = document;
      returnValue.newDocument = null;
      return returnValue;
    } else if (operation.op === '_get') {
      operation.value = document;
      return returnValue;
    } else { /* bad operation */
      if (validateOperation) {
        throw new JsonPatchError('Operation `op` property is not one of operations defined in RFC-6902', 'OPERATION_OP_INVALID', 0, operation, document);
      } else {
        return returnValue;
      }
    }
  } /* END ROOT OPERATIONS */
  else {
    if (!mutateDocument) {
      document = _deepClone(document);
    }
    const path = operation.path || "";
    const keys = path.split('/');
    let obj = document;
    let t = 1; //skip empty element - http://jsperf.com/to-shift-or-not-to-shift
    let len = keys.length;
    let existingPathFragment = undefined;
    let key: string | number;
    let validateFunction;
    if (typeof validateOperation == 'function') {
      validateFunction = validateOperation;
    }
    else {
      validateFunction = validator;
    }
    while (true) {
      key = keys[t];

      if (validateOperation) {
        if (existingPathFragment === undefined) {
          if (obj[key] === undefined) {
            existingPathFragment = keys.slice(0, t).join('/');
          }
          else if (t == len - 1) {
            existingPathFragment = operation.path;
          }
          if (existingPathFragment !== undefined) {
            validateFunction(operation, 0, document, existingPathFragment);
          }
        }
      }
      t++;
      if (Array.isArray(obj)) {
        if (key === '-') {
          key = obj.length;
        }
        else {
          if (validateOperation && !isInteger(key)) {
            throw new JsonPatchError("Expected an unsigned base-10 integer value, making the new referenced value the array element with the zero-based index", "OPERATION_PATH_ILLEGAL_ARRAY_INDEX", 0, operation.path, operation);
          } // only parse key when it's an integer for `arr.prop` to work
          else if(isInteger(key)) {
            key = ~~key;
          }
        }
        if (t >= len) {
          if (validateOperation && operation.op === "add" && key > obj.length) {
            throw new JsonPatchError("The specified index MUST NOT be greater than the number of elements in the array", "OPERATION_VALUE_OUT_OF_BOUNDS", 0, operation.path, operation);
          }
          const returnValue = arrOps[operation.op].call(operation, obj, key, document); // Apply patch
          if (returnValue.test === false) {
            throw new JsonPatchError("Test operation failed", 'TEST_OPERATION_FAILED', 0, operation, document);
          }
          return returnValue;
        }
      }
      else {
        if (key && key.indexOf('~') != -1) {
          key = unescapePathComponent(key);
        }
        if (t >= len) {
          const returnValue = objOps[operation.op].call(operation, obj, key, document); // Apply patch
          if (returnValue.test === false) {
            throw new JsonPatchError("Test operation failed", 'TEST_OPERATION_FAILED', 0, operation, document);
          }
          return returnValue;
        }
      }
      obj = obj[key];
    }
  }
}

/**
 * Apply a full JSON Patch array on a JSON document.
 * Returns the {newDocument, result} of the patch.
 * It modifies the `document` object and `patch` - it gets the values by reference.
 * If you would like to avoid touching your values, clone them:
 * `jsonpatch.applyPatch(document, jsonpatch._deepClone(patch))`.
 *
 * @param document The document to patch
 * @param patch The patch to apply
 * @param validateOperation `false` is without validation, `true` to use default jsonpatch's validation, or you can pass a `validateOperation` callback to be used for validation.
 * @param mutateDocument Whether to mutate the original document or clone it before applying
 * @return An array of `{newDocument, result}` after the patch
 */
export function applyPatch<T>(document: T, patch: Operation[], validateOperation?: boolean | Validator<T>, mutateDocument: boolean = true): PatchResult<T> {
  if(validateOperation) {
    if(!Array.isArray(patch)) {
      throw new JsonPatchError('Patch sequence must be an array', 'SEQUENCE_NOT_AN_ARRAY');
    }
  }
  if (!mutateDocument) {
    document = _deepClone(document);
  }
  const results = new Array(patch.length) as PatchResult<T>;

  for (let i = 0, length = patch.length; i < length; i++) {
    results[i] = applyOperation(document, patch[i], validateOperation);
    document = results[i].newDocument; // in case root was replaced
  }
  results.newDocument = document;
  return results;
}

/**
 * Apply a single JSON Patch Operation on a JSON document.
 * Returns the updated document.
 * Suitable as a reducer.
 *
 * @param document The document to patch
 * @param operation The operation to apply
 * @return The updated document
 */
export function applyReducer<T>(document: T, operation: Operation): T {
  const operationResult: OperationResult<T> = applyOperation(document, operation)
  if (operationResult.test === false) { // failed test
    throw new JsonPatchError("Test operation failed", 'TEST_OPERATION_FAILED', 0, operation, document);
  }
  return operationResult.newDocument;
}

/**
 * Validates a single operation. Called from `jsonpatch.validate`. Throws `JsonPatchError` in case of an error.
 * @param {object} operation - operation object (patch)
 * @param {number} index - index of operation in the sequence
 * @param {object} [document] - object where the operation is supposed to be applied
 * @param {string} [existingPathFragment] - comes along with `document`
 */
export function validator(operation: Operation, index: number, document?: any, existingPathFragment?: string): void {
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    throw new JsonPatchError('Operation is not an object', 'OPERATION_NOT_AN_OBJECT', index, operation, document);
  }

  else if (!objOps[operation.op]) {
    throw new JsonPatchError('Operation `op` property is not one of operations defined in RFC-6902', 'OPERATION_OP_INVALID', index, operation, document);
  }

  else if (typeof operation.path !== 'string') {
    throw new JsonPatchError('Operation `path` property is not a string', 'OPERATION_PATH_INVALID', index, operation, document);
  }

  else if (operation.path.indexOf('/') !== 0 && operation.path.length > 0) {
    // paths that aren't empty string should start with "/"
    throw new JsonPatchError('Operation `path` property must start with "/"', 'OPERATION_PATH_INVALID', index, operation, document);
  }

  else if ((operation.op === 'move' || operation.op === 'copy') && typeof operation.from !== 'string') {
    throw new JsonPatchError('Operation `from` property is not present (applicable in `move` and `copy` operations)', 'OPERATION_FROM_REQUIRED', index, operation, document);
  }

  else if ((operation.op === 'add' || operation.op === 'replace' || operation.op === 'test') && operation.value === undefined) {
    throw new JsonPatchError('Operation `value` property is not present (applicable in `add`, `replace` and `test` operations)', 'OPERATION_VALUE_REQUIRED', index, operation, document);
  }

  else if ((operation.op === 'add' || operation.op === 'replace' || operation.op === 'test') && hasUndefined(operation.value)) {
    throw new JsonPatchError('Operation `value` property is not present (applicable in `add`, `replace` and `test` operations)', 'OPERATION_VALUE_CANNOT_CONTAIN_UNDEFINED', index, operation, document);
  }

  else if (document) {
    if (operation.op == "add") {
      var pathLen = operation.path.split("/").length;
      var existingPathLen = existingPathFragment.split("/").length;
      if (pathLen !== existingPathLen + 1 && pathLen !== existingPathLen) {
        throw new JsonPatchError('Cannot perform an `add` operation at the desired path', 'OPERATION_PATH_CANNOT_ADD', index, operation, document);
      }
    }
    else if (operation.op === 'replace' || operation.op === 'remove' || (<any>operation.op) === '_get') {
      if (operation.path !== existingPathFragment) {
        throw new JsonPatchError('Cannot perform the operation at a path that does not exist', 'OPERATION_PATH_UNRESOLVABLE', index, operation, document);
      }
    }
    else if (operation.op === 'move' || operation.op === 'copy') {
      var existingValue: any = { op: "_get", path: operation.from, value: undefined };
      var error = validate([existingValue], document);
      if (error && error.name === 'OPERATION_PATH_UNRESOLVABLE') {
        throw new JsonPatchError('Cannot perform the operation from a path that does not exist', 'OPERATION_FROM_UNRESOLVABLE', index, operation, document);
      }
    }
  }
}

/**
 * Validates a sequence of operations. If `document` parameter is provided, the sequence is additionally validated against the object document.
 * If error is encountered, returns a JsonPatchError object
 * @param sequence
 * @param document
 * @returns {JsonPatchError|undefined}
 */
export function validate<T>(sequence: Operation[], document?: T, externalValidator?: Validator<T>): PatchError {
  try {
    if (!Array.isArray(sequence)) {
      throw new JsonPatchError('Patch sequence must be an array', 'SEQUENCE_NOT_AN_ARRAY');
    }
    if (document) {
      //clone document and sequence so that we can safely try applying operations
      applyPatch(_deepClone(document), _deepClone(sequence), externalValidator || true);
    }
    else {
      externalValidator = externalValidator || validator;
      for (var i = 0; i < sequence.length; i++) {
        externalValidator(sequence[i], i, document, undefined);
      }
    }
  }
  catch (e) {
    if (e instanceof JsonPatchError) {
      return e;
    }
    else {
      throw e;
    }
  }
}
