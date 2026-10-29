import { map } from '../common/map.mjs';
import { nullTag } from '../common/null.mjs';
import { seq } from '../common/seq.mjs';
import { string } from '../common/string.mjs';
import { boolTag } from './bool.mjs';
import { floatNaN, floatExp, float } from './float.mjs';
import { intOct, int, intHex } from './int.mjs';

const schema = [
    map,
    seq,
    string,
    nullTag,
    boolTag,
    intOct,
    int,
    intHex,
    floatNaN,
    floatExp,
    float
];

export { schema };
