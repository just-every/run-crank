import { map } from '../common/map.mjs';
import { nullTag } from '../common/null.mjs';
import { seq } from '../common/seq.mjs';
import { string } from '../common/string.mjs';
import { binary } from './binary.mjs';
import { trueTag, falseTag } from './bool.mjs';
import { floatNaN, floatExp, float } from './float.mjs';
import { intBin, intOct, int, intHex } from './int.mjs';
import { merge } from './merge.mjs';
import { omap } from './omap.mjs';
import { pairs } from './pairs.mjs';
import { set } from './set.mjs';
import { intTime, floatTime, timestamp } from './timestamp.mjs';

const schema = [
    map,
    seq,
    string,
    nullTag,
    trueTag,
    falseTag,
    intBin,
    intOct,
    int,
    intHex,
    floatNaN,
    floatExp,
    float,
    binary,
    merge,
    omap,
    pairs,
    set,
    intTime,
    floatTime,
    timestamp
];

export { schema };
