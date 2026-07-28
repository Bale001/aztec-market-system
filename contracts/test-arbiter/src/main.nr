// TestArbiter -- a TEST FIXTURE, not part of the system.
//
// OrderEscrow reads its arbitrating marketplace's public `order_states` map
// from the anchor block header. Standing up a whole Marketplace inside the
// escrow's tests (config, vendor, listing, order) would test the marketplace,
// not the escrow, so this stands in for it: the same storage shape
// (`Map<Field, PublicMutable<u8>>`), settable directly.
//
// The escrow takes the map's base slot as a bound term precisely so it needs no
// compile-time knowledge of who is arbitrating -- which is what lets this
// fixture substitute for the real marketplace here.

use ::aztec::macros::aztec;

#[aztec]
pub contract TestArbiter {
    use ::aztec::macros::{functions::external, storage::storage};
    use ::aztec::state_vars::{Map, PublicMutable, StateVariable};

    #[storage]
    struct Storage<Context> {
        order_states: Map<Field, PublicMutable<u8, Context>, Context>,
    }

    #[external("public")]
    fn set_order_state(order_id: Field, state: u8) {
        self.storage.order_states.at(order_id).write(state);
    }

    /// The base slot the escrow needs as one of its bound terms.
    #[external("utility")]
    unconstrained fn order_states_slot() -> Field {
        self.storage.order_states.get_storage_slot()
    }
}
