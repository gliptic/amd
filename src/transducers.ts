
type IteratorResult = { value?: any; done?: boolean };

interface Iterator { next(): IteratorResult; }

declare var Symbol: any;

define(function () {

	/** @const */
	var DEBUG = false;
	/** @const */
	var CHECK_CYCLES = DEBUG || false;
	/** @const */
	var DEBUG_SIGNALS = DEBUG || false;
	/** @const */
	var SIMULATE_RANDOM_ERRORS_IN_SIGNAL = false;
	
	function id(v) {
		return v;
	}

	function nop() {
	}

	var arrayReducer: Transducer<any, any[]> = (s: any) => {
		s = s || [];
		return inherit({ b: () => s },
			v => { s.push(v); })
	};

	var objReducer: Transducer<any, any> = (s: any) => {
		s = s || {};
		return inherit({ b: () => s },
			v => objMerge(v, s));
	};

	var protocolIterator = Symbol ? Symbol.iterator : '@@iterator';

	function iterator(coll): Iterator {
		if (coll[protocolIterator])
			return coll[protocolIterator].call(coll);
	}

	function compose<A, B, C>(a: Transducer<A, B>, b: Transducer<B, C>): Transducer<A, C> {
		return function(r: any) {
			return a(b(r));
		}
	}

	function objBind(coll, f: Reducer<any>) {
		return Object.keys(coll).some(k => <any>f([k, coll[k]]));
	}

	function objMerge(src, dest) {
		if (Array.isArray(src)) {
			dest[src[0]] = src[1];
		} else {
			objBind(src, v => objMerge(v, dest));
		}
	}

	function getReducer(v) {
		if (Array.isArray(v))
			return arrayReducer(v);
		else if (typeof v == "object")
			return objReducer(v);
		else
			return v; // Default to array
	}

	function reduce(coll, reducer: Reducer<any>): any {
		internalReduce(coll, reducer);
		return reducer.b && reducer.b();
	}

	function internalReduce(coll, reducer: Reducer<any>) {
		var c = false;
		if (Array.isArray(coll)) {
			c = coll.some(reducer);
		} else if (coll.then) {
			coll.then(reducer);
		} else {
			var iter = iterator(coll), val;
			if (!iter) {
				c = objBind(coll, reducer);
			} else {
				for (;val = iter.next(), !(c || val.done);) {
					c = reducer(val.value);
				}
			}
			
		}

		return c;
	}

	function inherit(reducer, f): any {
		if (reducer.b) f.b = reducer.b;
		return f;
	}

	function reducep<T>(f: Reducer<T>): Transducer<any, T> {
		return reducer => {
			return inherit(reducer, (input: T) => {
				f(input);
				return reducer(f.b());
			});
		};
	}

	function map<I, O>(f: (v: I) => O): Transducer<I, O> {
		return reducer => {
			return inherit(reducer, (input: I) => { return reducer(f(input)); });
		};
	}

	function filter<T>(f: (T: any) => boolean): Transducer<T, T> {
		return reducer => {
			return inherit(reducer, (input: T) => { return f(input) && reducer(input); });
		};
	}

	function take<T>(n: number): Transducer<T, T> {
		return reducer => {
			var l = n;
			return inherit(reducer, (input: T) => {
				return --l < 0 || reducer(input) || !l;
			});
		};
	}

	function drop<T>(n: number): Transducer<T, T> {
		return reducer => {
			var l = n;
			return inherit(reducer, (input: T) => {
				return --l < 0 && reducer(input);
			});
		};
	}

	function takeWhile<T>(f: (v: T) => boolean): Transducer<T, T> {
		return reducer => {
			return inherit(reducer, (input: T) => {
				return !f(input) || reducer(input);
			});
		};
	}

	function dropWhile<T>(f: (v: T) => boolean): Transducer<T, T> {
		return reducer => {
			var f2: any = f;
			return inherit(reducer, (input: T) => {
				return !f2 || !f2(input) && (f2 = 0, reducer(input));
			});
		};
	}

	function fold<T>(f: (x: T, y: T) => T): Transducer<T, T> {
		return (s: any) => {
			var r: Reducer<T> = (input: T) => s = f(s, input);
			r.b = () => s;
			return r;
		};
	}

	// These are functions
	function wait<I, O>(next: Transducer<I, O>): Transducer<I, O> {
		var o = 1, res = sig(true);

		return inherit({
			b: function () { --o || res(next.b && next.b(), true); return res; }
		}, (reducer: Reducer<O>) => {
			var wrapped = next(reducer);

			++o;
			return inherit({
				b: function () { --o || res(next.b && next.b(), true); }
			}, wrapped);
		});
	}

	function latest<I, O>(next: Transducer<I, O>): Transducer<I, O> {
		var cur = 0;
		return inherit(next, (reducer: Reducer<O>) => {
			var wrapped = next(reducer);
			var me = ++cur;
			return inherit(wrapped, (input: I) => {
				return !(cur == me) || wrapped(input);
			});
		});
	}

	function defaultJoin(reducer: Reducer<any>): Transducer<any, any> {
		return inherit(reducer, () => {
			return (input) => reducer(input);
		});
	}

	// Concatenate a sequence of reducible objects into one sequence
	function cat(join?: any): Transducer<any, any> {
		join = join || id;
		return (reducer: Reducer<any>) => {
			var tempJoin = join(defaultJoin(reducer));
			return inherit(tempJoin, (input) => {
				return internalReduce(input, tempJoin());
			});
		};
	}

	// Also called flatMap, >>=, bind and others.
	function mapcat<I>(f: (v: I) => any, join?: Transducer<any, any>): Transducer<I, any> {
		return compose(map(f), cat(join));
	}

	function match<I, O>(coll: ((v: I) => O)[]): Transducer<I, O> {
		return reducer => {
			return inherit(reducer, (input: I) => {
				var c;
				coll.some(x => {
					var v = x(input);
					return (v != void 0) && (c = reducer(v), true);
				});
				return c;
			});
		};
	}

	function process<T>(r: Reducer<T>): Reducer<T> {
		var c = false;
		return v => c || (c = r(v));
	}

	function every(interval: number): Signal<number> {
		var s = sig();

		function set() {
			setTimeout(() => {
				s(1) || set();
			}, interval);
		}

		set();

		return s;
	}

	function delay<T>(ms: number, v?: T | Error): Signal<T | Error> {
		var s = sig();

		setTimeout(() => {
			if (SIMULATE_RANDOM_ERRORS_IN_SIGNAL && Math.random() < 0.3) v = new Error("Error in delay");
			s(v, true);
		}, ms);
		
		return s;
	}

	function sig<T>(persistent?: boolean): Signal<T> {
		var subs = [],
			lastValue,
			isDone = false,
			isProcessing = false;

		function processOne(lease, val): any {
			return ((val == void 0 || !lease(val)) && !isDone) || (lease.b && lease.b(), false);
		}

		var s: any = (val, done?) => {
			DEBUG_SIGNALS && console.log('signalled', val, 'leases:', subs.length);
			if (CHECK_CYCLES) {
				if (isProcessing) {
					throw 'Cyclic';
				}
				isProcessing = true;
			}
			if (val != void 0) lastValue = val;
			isDone = done;
			subs = subs.filter(lease => processOne(lease, val));
			if (CHECK_CYCLES) { isProcessing = false }
			return !subs.length || !s.then;
		};

		s.then = (reducer: Reducer<T>) => {
			
			if (processOne(reducer, lastValue))
				subs.push(reducer);
			
			return lastValue != void 0;
		};

		s.t = sig; // Mark as signal

		return s;
	}

	function done<T>(ev: Reducer<T>): Transducer<T, T> {
		return reducer => {
			var r = inherit(reducer, (input: any) => reducer(input));
			r.b = function () {
				var v = reducer.b();
				ev(v);
				ev.b && ev.b();
				return v;
			};
			return r;
		}
	}

/*
	function pre(ev: Reducer): Transducer {
		return reducer => {
			var r = inherit(reducer, function (input) {
				return ev(input) || reducer(input);
			});
			r.b = function () {
				ev.b && ev.b();
				return reducer.b && reducer.b();
			};
			// TODO: Leases?
			return r;
		};
	}

	function post(ev: Reducer): Transducer {
		return reducer => {
			var r = inherit(reducer, function (input) {
				return reducer(input) || ev(input);
			});
			r.b = function () {
				ev.b && ev.b();
				return reducer.b && reducer.b();
			};
			// TODO: Leases?
			return r;
		};
	}
*/

	function to(dest?: Object | any[] | Reducer<any>): Reducer<any> {
		return this(getReducer(dest));
	}

/*
	function err<T>(ev: Reducer<T>): Transducer<T, T> {
		return reducer => {
			var r = inherit(reducer, function (input: T) {
				if (input instanceof Error) {
					return ev(input);
				} else {
					return reducer(input);
				}
			});
			r.b = function () {
				ev.b && ev.b();
				return reducer.b && reducer.b();
			};
			// TODO: Leases?
			return r;
		};
	}*/

	function err<T>(ev: Reducer<T>): Transducer<T, T> {
		return reducer => {
			var r = inherit(reducer, (input: any) => reducer(input));
			r.b = function (err) {
				err && ev(err);
				return reducer.b && reducer.b();
			};
			// TODO: Leases?
			return r;
		};
	}

	var mod = id;

	var transducerFunctions = {
		map: map,
		filter: filter,
		take: take,
		takeWhile: takeWhile,
		drop: drop,
		dropWhile: dropWhile,
		mapcat: mapcat,
		cat: cat,
		match: match,
		err: err,
		done: done,
		//pre: pre,
		//post: post,
		//fold: fold,
		//to: to
	};

	// Methods on transducers for chaining

	// Mod works like the null transducer.
	// This is a bit dirty. See if there's a better way.
	mod = id;
	objBind(transducerFunctions, v => {
		var innerF = v[1];
		function fluentWrapper() {
			var rhs = innerF.apply(null, arguments),
				lhs = this;
			var td: Transducer<any, any> = compose(lhs, rhs);
			objBind(transducerFunctions, v2 => { td[v2[0]] = mod[v2[0]] });
			td.to = to;
			return td;
		}

		mod[v[0]] = fluentWrapper;
	});

	objMerge({
			//pipe: pipe,
			//into: into,
			compose: compose,
			
			reducep: reducep,
			reduce: reduce,
			wait: wait,
			latest: latest,

			// Signals
			process: process,
			//everySecond: everySecond,
			delay: delay,
			sig: sig,
			//every: every
		}, mod);

	return mod;
})
