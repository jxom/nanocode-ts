#[path = "../../python/src/lib.rs"]
mod python;

use py_polars_nanocode as _;

#[link(wasm_import_module = "python")]
unsafe extern "C" {
    fn host_random(bytes: *mut u8, len: usize);
}

unsafe extern "C" {
    fn PyInit_polars() -> *mut std::ffi::c_void;
}

static EXTENSIONS: [nanocode_python::Extension; 1] =
    [nanocode_python::Extension::new("polars.polars", PyInit_polars)];

static FROZEN: &nanocode_python::rustpython_vm::frozen::FrozenLib = nanocode_python::rustpython_vm::py_freeze!(
    dir = "../../target/polars-site",
    crate_name = "nanocode_python::rustpython_vm"
);

extern "C" fn register() {
    assert!(nanocode_python::add_extensions(&EXTENSIONS).is_ok());
    assert!(nanocode_python::add_frozen(FROZEN).is_ok());
}

#[used]
#[unsafe(link_section = ".init_array")]
static REGISTER: extern "C" fn() = register;

#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(dest: *mut u8, len: usize) -> Result<(), getrandom::Error> {
    unsafe { host_random(dest, len) };
    Ok(())
}

fn fill(bytes: &mut [u8]) -> Result<(), old_getrandom::Error> {
    unsafe { host_random(bytes.as_mut_ptr(), bytes.len()) };
    Ok(())
}

old_getrandom::register_custom_getrandom!(fill);
