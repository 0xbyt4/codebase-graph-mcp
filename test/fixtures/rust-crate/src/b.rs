use super::*;
use crate::{
    a, // the sibling module
    Item as Renamed,
};
pub struct Thing(Renamed);
pub fn h() { a::f(); }
