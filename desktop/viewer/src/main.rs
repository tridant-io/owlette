// no console window behind any build: the log plugin writes to a file and a debug build
// exposes cdp on 9222, so a console only ever surprised the operator who closed the app
#![windows_subsystem = "windows"]

fn main() {
  owlette_swoop_viewer_lib::run();
}
