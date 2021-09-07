/**
 * External dependencies
 */
import { invert, omit } from 'lodash';

/**
 * WordPress dependencies
 */
import { __, sprintf } from '@wordpress/i18n';
import { store as noticesStore } from '@wordpress/notices';
import { serialize } from '@wordpress/blocks';
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import { STORE_NAME } from './constants';
import { NAVIGATION_POST_KIND, NAVIGATION_POST_POST_TYPE } from '../constants';
import { menuItemsQuery, blockAttributesToMenuItem } from './utils';

/**
 * Returns an action object used to select menu.
 *
 * @param {number} menuId The menu ID.
 * @return {Object} Action object.
 */
export function setSelectedMenuId( menuId ) {
	return {
		type: 'SET_SELECTED_MENU_ID',
		menuId,
	};
}

/**
 * Creates a menu item for every block that doesn't have an associated menuItem.
 * Requests POST /wp/v2/menu-items once for every menu item created.
 *
 * @param {Object} post A navigation post to process
 * @return {Function} An action creator
 */
export const createMissingMenuItems = ( post ) => async ( {
	dispatch,
	registry,
} ) => {
	const menuId = post.meta.menuId;
	// @TODO: extract locks to a separate package?
	const lock = await registry
		.dispatch( 'core' )
		.__unstableAcquireStoreLock( STORE_NAME, [ 'savingMenu' ], {
			exclusive: false,
		} );
	try {
		const mapping = await getMenuItemToClientIdMapping( registry, post.id );
		const clientIdToMenuId = invert( mapping );

		const stack = [ post.blocks[ 0 ] ];
		while ( stack.length ) {
			const block = stack.pop();
			if ( ! ( block.clientId in clientIdToMenuId ) ) {
				const menuItem = await apiFetch( {
					path: `/__experimental/menu-items`,
					method: 'POST',
					data: {
						title: 'Placeholder',
						url: 'Placeholder',
						menu_order: 0,
					},
				} );

				mapping[ menuItem.id ] = block.clientId;
				const menuItems = await registry
					.resolveSelect( 'core' )
					.getMenuItems( { menus: menuId, per_page: -1 } );

				await registry
					.dispatch( 'core' )
					.receiveEntityRecords(
						'root',
						'menuItem',
						[ ...menuItems, menuItem ],
						menuItemsQuery( menuId ),
						false
					);
			}
			stack.push( ...block.innerBlocks );
		}

		dispatch( {
			type: 'SET_MENU_ITEM_TO_CLIENT_ID_MAPPING',
			postId: post.id,
			mapping,
		} );
	} finally {
		await registry.dispatch( 'core' ).__unstableReleaseStoreLock( lock );
	}
};

/**
 * Converts all the blocks into menu items and submits a batch request to save everything at once.
 *
 * @param {Object} post A navigation post to process
 * @return {Function} An action creator
 */
export const saveNavigationPost = ( post ) => async ( {
	registry,
	dispatch,
} ) => {
	const lock = await registry
		.dispatch( 'core' )
		.__unstableAcquireStoreLock( STORE_NAME, [ 'savingMenu' ], {
			exclusive: true,
		} );
	try {
		const menuId = post.meta.menuId;
		const menuItems = await registry
			.resolveSelect( 'core' )
			.getMenuItems( { menus: menuId, per_page: -1 } );

		const menuItemsByClientId = mapMenuItemsByClientId(
			menuItems,
			getMenuItemToClientIdMapping( registry, post.id )
		);

		await registry
			.dispatch( 'core' )
			.saveEditedEntityRecord( 'root', 'menu', menuId );

		const error = registry
			.select( 'core' )
			.getLastEntitySaveError( 'root', 'menu', menuId );

		if ( error ) {
			throw new Error( error.message );
		}

		// Save blocks as menu items.
		await dispatch(
			batchSave( menuId, menuItemsByClientId, post.blocks[ 0 ] )
		);

		// Clear "stub" navigation post edits to avoid a false "dirty" state.
		await registry
			.dispatch( 'core' )
			.receiveEntityRecords(
				NAVIGATION_POST_KIND,
				NAVIGATION_POST_POST_TYPE,
				[ post ],
				undefined
			);

		await registry
			.dispatch( noticesStore )
			.createSuccessNotice( __( 'Navigation saved.' ), {
				type: 'snackbar',
			} );
	} catch ( saveError ) {
		const errorMessage = saveError
			? sprintf(
					/* translators: %s: The text of an error message (potentially untranslated). */
					__( "Unable to save: '%s'" ),
					saveError.message
			  )
			: __( 'Unable to save: An error o1curred.' );
		await registry
			.dispatch( noticesStore )
			.createErrorNotice( errorMessage, {
				type: 'snackbar',
			} );
	} finally {
		await registry.dispatch( 'core' ).__unstableReleaseStoreLock( lock );
	}
};

const getMenuItemToClientIdMapping = ( registry, postId ) =>
	registry.stores[ STORE_NAME ].store.getState().mapping[ postId ] || {};

function mapMenuItemsByClientId( menuItems, clientIdsByMenuId ) {
	const result = {};
	if ( ! menuItems || ! clientIdsByMenuId ) {
		return result;
	}
	for ( const menuItem of menuItems ) {
		const clientId = clientIdsByMenuId[ menuItem.id ];
		if ( clientId ) {
			result[ clientId ] = menuItem;
		}
	}
	return result;
}

// saveEntityRecord for each menu item with block-based data
// saveEntityRecord for each deleted menu item
const batchSave = ( menuId, menuItemsByClientId, navigationBlock ) => async ( {
	registry,
} ) => {
	const blocksList = blocksTreeToFlatList( navigationBlock.innerBlocks );

	const batchTasks = [];

	// Compute deletes
	const clientIdToBlockId = Object.fromEntries(
		blocksList.map( ( { block } ) => [
			block.clientId,
			getMenuItemForBlock( block ).id,
		] )
	);
	const deletedMenuItems = [];
	for ( const clientId in menuItemsByClientId ) {
		if ( ! ( clientId in clientIdToBlockId ) ) {
			deletedMenuItems.push( menuItemsByClientId[ clientId ].id );
		}
	}

	// Enqueue updates
	for ( const { block, parentId, position } of blocksList ) {
		const menuItem = getMenuItemForBlock( block );
		if ( deletedMenuItems.includes( menuItem.id ) ) {
			continue;
		}

		// Update an existing navigation item.
		await registry
			.dispatch( 'core' )
			.editEntityRecord(
				'root',
				'menuItem',
				menuItem.id,
				blockToEntityRecord( block, parentId, position ),
				{ undoIgnore: true }
			);

		const hasEdits = registry
			.select( 'core' )
			.hasEditsForEntityRecord( 'root', 'menuItem', menuItem.id );

		if ( ! hasEdits ) {
			continue;
		}

		batchTasks.unshift( ( { saveEditedEntityRecord } ) =>
			saveEditedEntityRecord( 'root', 'menuItem', menuItem.id )
		);
	}

	// Enqueue deletes
	for ( const menuItemId of deletedMenuItems ) {
		batchTasks.unshift( ( { deleteEntityRecord } ) =>
			deleteEntityRecord( 'root', 'menuItem', menuItemId )
		);
	}

	return await registry.dispatch( 'core' ).__experimentalBatch( batchTasks );

	function blockToEntityRecord( block, parentId, position ) {
		const menuItem = omit( getMenuItemForBlock( block ), 'menus', 'meta' );

		let attributes;

		if ( block.name === 'core/navigation-link' ) {
			attributes = blockAttributesToMenuItem( block.attributes );
		} else {
			attributes = {
				type: 'block',
				content: serialize( block ),
			};
		}

		return {
			...menuItem,
			...attributes,
			position,
			nav_menu_term_id: menuId,
			menu_item_parent: parentId,
			status: 'publish',
			_invalid: false,
		};
	}

	function blocksTreeToFlatList( innerBlocks, parentId = 0 ) {
		return innerBlocks.flatMap( ( block, index ) =>
			[ { block, parentId, position: index + 1 } ].concat(
				blocksTreeToFlatList(
					block.innerBlocks,
					getMenuItemForBlock( block )?.id
				)
			)
		);
	}

	function getMenuItemForBlock( block ) {
		return omit( menuItemsByClientId[ block.clientId ] || {}, '_links' );
	}
};

/**
 * Returns an action object used to open/close the inserter.
 *
 * @param {boolean|Object} value                Whether the inserter should be
 *                                              opened (true) or closed (false).
 *                                              To specify an insertion point,
 *                                              use an object.
 * @param {string}         value.rootClientId   The root client ID to insert at.
 * @param {number}         value.insertionIndex The index to insert at.
 *
 * @return {Object} Action object.
 */
export function setIsInserterOpened( value ) {
	return {
		type: 'SET_IS_INSERTER_OPENED',
		value,
	};
}
