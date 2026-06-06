//! Tiny demo workloads, compiled to wasm32 and pushed to browser nodes to run on-device.
//! Each export is a plain integer function callable as `instance.exports.<name>(...args)`.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

/// Count primes below `n` by trial division — a deliberate CPU burn for the demo.
#[no_mangle]
pub extern "C" fn count_primes(n: i32) -> i32 {
    if n < 3 {
        return 0;
    }
    let n = n as u32;
    let mut count = 1; // 2
    let mut k: u32 = 3;
    while k < n {
        let mut is_prime = true;
        let mut d: u32 = 3;
        while d * d <= k {
            if k % d == 0 {
                is_prime = false;
                break;
            }
            d += 2;
        }
        if is_prime {
            count += 1;
        }
        k += 2;
    }
    count
}

/// Fibonacci(n), iterative — returns i64 (arrives in JS as BigInt).
#[no_mangle]
pub extern "C" fn fib(n: i32) -> i64 {
    let mut a: i64 = 0;
    let mut b: i64 = 1;
    let mut i = 0;
    while i < n {
        let t = a.wrapping_add(b);
        a = b;
        b = t;
        i += 1;
    }
    a
}

/// Sum of i*i for i in 0..n — a cheap arithmetic load returning i64.
#[no_mangle]
pub extern "C" fn sum_squares(n: i32) -> i64 {
    let mut s: i64 = 0;
    let mut i: i64 = 0;
    let n = n as i64;
    while i < n {
        s = s.wrapping_add(i.wrapping_mul(i));
        i += 1;
    }
    s
}
