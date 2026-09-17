use super::Item;
use crate::b::Thing;
mod inner;
pub fn f() -> (Item, Thing) { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;
    use super::f;
    use self::helper;
    fn helper() {}
    #[test]
    fn t() { let _ = f(); helper(); }
}
